/**
 * Comments (doc 01 L1; operational narrative). Polymorphic: a comment attaches
 * to any ATTACHABLE_TYPES entity by (type, id). Creation writes an `activity`
 * row (tenant-visible narrative — not audit); edit/soft-delete are org-scoped.
 * The target entity's existence is the owning module's concern (target tables
 * arrive with their features); this service is the storage + access substrate.
 */
import { z } from "zod";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { recordActivity } from "@/platform/audit";
import { ATTACHABLE_TYPES, type AttachableType } from "@/platform/registries";

export class CommentError extends Error {
  constructor(
    public readonly code: "not_found" | "forbidden" | "invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "CommentError";
  }
}

export const CreateCommentInput = z.object({
  entityType: z.enum(ATTACHABLE_TYPES as unknown as [string, ...string[]]),
  entityId: z.string().uuid(),
  body: z.string().trim().min(1).max(4000),
});
export type CreateCommentInput = z.infer<typeof CreateCommentInput>;

export type Comment = {
  id: string;
  entityType: string;
  entityId: string;
  authorUserId: string;
  authorName: string;
  body: string;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
};

function mapRow(r: Record<string, unknown>): Comment {
  return {
    id: r.id as string,
    entityType: r.entity_type as string,
    entityId: r.entity_id as string,
    authorUserId: r.author_user_id as string,
    authorName: (r.author_name as string) ?? "",
    body: r.body as string,
    editedAt: (r.edited_at as string | null) ?? null,
    deletedAt: (r.deleted_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

async function loadComment(tx: TenantTx, id: string): Promise<Comment | null> {
  const rows = (await tx.execute(sql`
    select c.id::text as id, c.entity_type, c.entity_id::text as entity_id,
           c.author_user_id::text as author_user_id, p.full_name as author_name,
           c.body, c.edited_at::text as edited_at, c.deleted_at::text as deleted_at,
           c.created_at::text as created_at
    from public.comment c
    join public.user_profile p on p.id = c.author_user_id
    where c.id = ${id}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createComment(ctx: Ctx, raw: unknown): Promise<string> {
  const input = CreateCommentInput.parse(raw);
  const id = await withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      insert into public.comment (org_id, entity_type, entity_id, author_user_id, body)
      values (${ctx.orgId}, ${input.entityType}, ${input.entityId}, ${ctx.userId}, ${input.body})
      returning id::text as id
    `)) as unknown as Array<{ id: string }>;
    return rows[0]!.id;
  });
  // Operational narrative (not audit) — the tenant-visible "who did what" stream.
  await recordActivity(ctx, {
    entityType: input.entityType as AttachableType,
    entityId: input.entityId,
    verb: "commented",
    summary: input.body.slice(0, 140),
  });
  return id;
}

export async function listComments(
  ctx: Ctx,
  entityType: AttachableType,
  entityId: string,
  includeDeleted = false,
): Promise<Comment[]> {
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select c.id::text as id, c.entity_type, c.entity_id::text as entity_id,
             c.author_user_id::text as author_user_id, p.full_name as author_name,
             c.body, c.edited_at::text as edited_at, c.deleted_at::text as deleted_at,
             c.created_at::text as created_at
      from public.comment c
      join public.user_profile p on p.id = c.author_user_id
      where c.org_id = ${ctx.orgId} and c.entity_type = ${entityType} and c.entity_id = ${entityId}
        ${includeDeleted ? sql`` : sql`and c.deleted_at is null`}
      order by c.created_at
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  });
}

/** Soft-delete (D-1.7): only the author may remove their own comment. */
export async function softDeleteComment(ctx: Ctx, id: string): Promise<void> {
  await withCtx(ctx, async (tx) => {
    const existing = await loadComment(tx, id);
    if (!existing) throw new CommentError("not_found", "comment not found");
    if (existing.authorUserId !== ctx.userId) {
      throw new CommentError("forbidden", "only the author can delete a comment");
    }
    await tx.execute(sql`
      update public.comment set deleted_at = now(), deleted_by = ${ctx.userId}
      where id = ${id} and org_id = ${ctx.orgId} and deleted_at is null
    `);
  });
}
