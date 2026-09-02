/**
 * H26 — collaboration (ADR-31): comments anchored to a block of a revision,
 * threads, mentions, resolution, and suggested changes that are applied only
 * by an explicit accept on the working revision (never silently).
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { createNotificationIn } from "@/platform/notifications";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { loadDocIn, loadRevisionIn } from "./documents";
import { appendEventIn } from "./events";
import { DocBody, DocError, LocaleText, bodyPlainText, type Block, type LeafBlock } from "./types";

export type CommentRow = {
  id: string;
  documentId: string;
  revisionId: string | null;
  blockId: string | null;
  parentId: string | null;
  body: string;
  authorUserId: string;
  authorName: string;
  mentions: string[];
  suggestion: { blockId: string; text: LocaleText } | null;
  suggestionStatus: "proposed" | "accepted" | "rejected" | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
};

const Suggestion = z
  .object({ blockId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), text: LocaleText })
  .strict();

export const CreateCommentInput = z
  .object({
    documentId: z.string().uuid(),
    revisionId: z.string().uuid().nullable().optional(),
    blockId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,40}$/)
      .nullable()
      .optional(),
    parentId: z.string().uuid().nullable().optional(),
    body: z.string().trim().min(1).max(4000),
    mentions: z.array(z.string().uuid()).max(20).default([]),
    suggestion: Suggestion.optional(),
  })
  .strict();

export async function createDocComment(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "comments.create");
  assertCan(archetype, "documents.view");
  const input = CreateCommentInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: input.suggestion ? "documents.comment.suggest" : "documents.comment.create",
        entityType: "document_comment",
        entityId: r.id,
        summary: input.suggestion ? "Suggested a change" : "Commented on a document",
      }),
      activity: {
        entityType: "document",
        entityId: input.documentId,
        verb: "commented",
        summary: input.suggestion ? "suggested a change" : "commented",
      },
    },
    async (tx) => {
      const d = await loadDocIn(tx, ctx, input.documentId);
      if (input.suggestion && d.issuedSnapshotId)
        throw new DocError(
          "an issued document takes no suggestions; create a successor",
          "immutable",
        );
      const rows = (await tx.execute(sql`
        insert into public.doc_comment
          (org_id, document_id, revision_id, block_id, parent_id, body, author_user_id, mentions, suggestion, suggestion_status)
        values (${ctx.orgId}, ${d.id}, ${input.revisionId ?? null}, ${input.blockId ?? null}, ${input.parentId ?? null},
                ${input.body}, ${ctx.userId},
                (select coalesce(array_agg(x::uuid), '{}'::uuid[]) from jsonb_array_elements_text(${JSON.stringify(input.mentions)}::jsonb) as x),
                ${input.suggestion ? JSON.stringify(input.suggestion) : null}::jsonb,
                ${input.suggestion ? "proposed" : null})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const id = rows[0]!.id;
      for (const userId of new Set(input.mentions)) {
        if (userId === ctx.userId) continue;
        await createNotificationIn(tx, ctx, {
          recipientUserId: userId,
          kind: "document_review_requested",
          title: `${d.reference} ${d.title}`,
          body: input.body.slice(0, 200),
          entityType: "document",
          entityId: d.id,
        });
      }
      await appendEventIn(tx, ctx, {
        documentId: d.id,
        kind: "comment_added",
        payload: {
          commentId: id,
          blockId: input.blockId ?? null,
          suggestion: Boolean(input.suggestion),
        },
      });
      return { id };
    },
  );
}

export async function listDocComments(
  ctx: Ctx,
  archetype: RoleArchetype,
  documentId: string,
): Promise<CommentRow[]> {
  assertCan(archetype, "documents.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select c.id::text as id, c.document_id::text as document_id, c.revision_id::text as revision_id, c.block_id,
             c.parent_id::text as parent_id, c.body, c.author_user_id::text as author_user_id,
             coalesce(p.full_name, '') as author_name,
             c.mentions, c.suggestion, c.suggestion_status, c.resolved_at::text as resolved_at,
             c.resolved_by::text as resolved_by, c.created_at::text as created_at
      from public.doc_comment c
      left join public.user_profile p on p.id = c.author_user_id
      where c.document_id = ${documentId} and c.org_id = ${ctx.orgId} and c.removed_at is null
      order by c.created_at
      limit 500
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    documentId: r.document_id as string,
    revisionId: (r.revision_id as string | null) ?? null,
    blockId: (r.block_id as string | null) ?? null,
    parentId: (r.parent_id as string | null) ?? null,
    body: r.body as string,
    authorUserId: r.author_user_id as string,
    authorName: r.author_name as string,
    mentions: (r.mentions as string[]) ?? [],
    suggestion: Suggestion.safeParse(r.suggestion).data ?? null,
    suggestionStatus: (r.suggestion_status as CommentRow["suggestionStatus"]) ?? null,
    resolvedAt: (r.resolved_at as string | null) ?? null,
    resolvedBy: (r.resolved_by as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

export async function resolveDocComment(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.view");
  const input = z
    .object({ commentId: z.string().uuid(), resolved: z.boolean().default(true) })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: input.resolved ? "documents.comment.resolve" : "documents.comment.reopen",
        entityType: "document_comment",
        entityId: input.commentId,
        summary: input.resolved ? "Resolved a comment" : "Reopened a comment",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.doc_comment
        set resolved_at = case when ${input.resolved} then now() else null end,
            resolved_by = case when ${input.resolved} then ${ctx.userId}::uuid else null end
        where id = ${input.commentId} and org_id = ${ctx.orgId} and removed_at is null
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new DocError("comment not found", "not_found");
      return { id: rows[0].id };
    },
  );
}

export async function removeDocComment(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "documents.view");
  const input = z.object({ commentId: z.string().uuid() }).parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "documents.comment.remove",
        entityType: "document_comment",
        entityId: input.commentId,
        summary: "Removed a comment",
      },
    },
    async (tx) => {
      // Authors remove their own; owner/admin may remove any.
      const privileged = archetype === "owner" || archetype === "admin";
      const rows = (await tx.execute(sql`
        update public.doc_comment set removed_at = now()
        where id = ${input.commentId} and org_id = ${ctx.orgId} and removed_at is null
          and (${privileged} or author_user_id = ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new DocError("comment not found", "not_found");
      return { id: rows[0].id };
    },
  );
}

/**
 * Accept or reject a suggested change. Accepting rewrites the named block's
 * text on the WORKING revision through the same row-version guard the editor
 * uses; the suggestion itself is never applied silently.
 */
export async function decideSuggestion(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; applied: boolean }> {
  assertCan(archetype, "documents.edit");
  const input = z
    .object({
      commentId: z.string().uuid(),
      decision: z.enum(["accepted", "rejected"]),
      expectedRowVersion: z.number().int().positive().optional(),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: {
        action:
          input.decision === "accepted"
            ? "documents.suggestion.accept"
            : "documents.suggestion.reject",
        entityType: "document_comment",
        entityId: input.commentId,
        summary:
          input.decision === "accepted"
            ? "Accepted a suggested change"
            : "Rejected a suggested change",
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select id::text as id, document_id::text as document_id, suggestion, suggestion_status
        from public.doc_comment where id = ${input.commentId} and org_id = ${ctx.orgId} and removed_at is null for update
      `)) as unknown as Array<{
        id: string;
        document_id: string;
        suggestion: unknown;
        suggestion_status: string | null;
      }>;
      const c = rows[0];
      if (!c) throw new DocError("comment not found", "not_found");
      if (c.suggestion_status !== "proposed")
        throw new DocError("this suggestion was already decided", "state");
      const suggestion = Suggestion.parse(c.suggestion);
      let applied = false;
      if (input.decision === "accepted") {
        const d = await loadDocIn(tx, ctx, c.document_id, true);
        if (!d.workingRevisionId || d.status !== "draft")
          throw new DocError("the document is not editable", "state");
        const rev = await loadRevisionIn(tx, ctx, d.workingRevisionId);
        if (input.expectedRowVersion !== undefined && rev.rowVersion !== input.expectedRowVersion)
          throw new DocError("revision changed since you loaded it", "conflict");
        let found = false;
        const apply = (b: Block): Block => {
          if (b.id !== suggestion.blockId) return b;
          if (
            b.type === "paragraph" ||
            b.type === "heading" ||
            b.type === "clause" ||
            b.type === "note"
          ) {
            found = true;
            return { ...b, text: suggestion.text };
          }
          return b;
        };
        const body = DocBody.parse({
          blocks: rev.body.blocks.map((b) =>
            b.type === "section"
              ? { ...b, blocks: b.blocks.map((x) => apply(x) as LeafBlock) }
              : apply(b),
          ),
        });
        if (!found)
          throw new DocError(
            "the suggested block no longer exists or is not a text block",
            "validation",
          );
        await tx.execute(sql`
          update public.doc_revision set body = ${JSON.stringify(body)}::jsonb, body_text = ${bodyPlainText(body)},
            row_version = row_version + 1, updated_by = ${ctx.userId}
          where id = ${rev.id} and org_id = ${ctx.orgId} and state = 'working'
        `);
        applied = true;
      }
      await tx.execute(sql`
        update public.doc_comment set suggestion_status = ${input.decision},
          resolved_at = now(), resolved_by = ${ctx.userId}
        where id = ${c.id} and org_id = ${ctx.orgId}
      `);
      await appendEventIn(tx, ctx, {
        documentId: c.document_id,
        kind: input.decision === "accepted" ? "suggestion_accepted" : "suggestion_rejected",
        payload: { commentId: c.id, blockId: suggestion.blockId },
      });
      return { id: c.id, applied };
    },
  );
}
