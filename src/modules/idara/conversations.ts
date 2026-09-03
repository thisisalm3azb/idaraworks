/**
 * H28 — conversations and messages (ADR-58/59). Private to the person who
 * owns them (RLS: org AND user); bounded reads; database-side paging; the
 * context capsule is stored per conversation as explicit record references.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AGENT_IDS, resolveAgentId, type AgentId } from "@/platform/agents/registry";
import { command } from "@/platform/audit";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { OutputBlock, Provenance, RecordRef } from "./types";
import { RUN_LIMITS } from "./types";

export const RecordRefSchema = z.object({
  type: z.string().regex(/^[a-z_]{1,40}$/),
  id: z.string().uuid(),
  label: z.string().max(200).optional(),
  href: z.string().max(400).optional(),
});

export const StartConversationInput = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(["quick", "session", "task"]).default("quick"),
  agentId: z.enum(AGENT_IDS).default("idara"),
  contextRefs: z.array(RecordRefSchema).max(RUN_LIMITS.maxContextRefs).default([]),
});

export type ConversationRow = {
  id: string;
  title: string;
  kind: string;
  agentId: AgentId;
  status: "active" | "archived";
  contextRefs: RecordRef[];
  messageCount: number;
  lastRunId: string | null;
  lastActivityAt: string;
  createdAt: string;
};

function rowOf(r: Record<string, unknown>): ConversationRow {
  const refs =
    typeof r.context_refs === "string"
      ? JSON.parse(r.context_refs as string)
      : (r.context_refs ?? []);
  return {
    id: String(r.id),
    title: String(r.title),
    kind: String(r.kind),
    agentId: resolveAgentId(String(r.agent_id) as AgentId),
    status: String(r.status) as "active" | "archived",
    contextRefs: Array.isArray(refs) ? (refs as RecordRef[]) : [],
    messageCount: Number(r.message_count ?? 0),
    lastRunId: (r.last_run_id as string | null) ?? null,
    lastActivityAt: String(r.last_activity_at),
    createdAt: String(r.created_at),
  };
}

export async function startConversation(ctx: Ctx, raw: unknown): Promise<ConversationRow> {
  const input = StartConversationInput.parse(raw);
  const id = randomUUID();
  const title = input.title ?? (input.kind === "quick" ? "Quick ask" : "New session");
  await command(
    ctx,
    {
      audit: {
        action: "idara.conversation.start",
        entityType: "ai_conversation",
        entityId: id,
        summary: `${input.kind} conversation with ${input.agentId} (${input.contextRefs.length} records shared)`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        insert into public.ai_conversation (id, org_id, user_id, title, kind, agent_id, context_refs)
        values (${id}, ${ctx.orgId}, ${ctx.userId}, ${title}, ${input.kind}, ${input.agentId}, ${JSON.stringify(input.contextRefs)}::jsonb)`);
      return null;
    },
  );
  const row = await getConversation(ctx, id);
  if (!row) throw new Error("conversation not visible after insert");
  return row;
}

export async function getConversation(ctx: Ctx, id: string): Promise<ConversationRow | null> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, title, kind, agent_id, status, context_refs, message_count, last_run_id::text as last_run_id,
             last_activity_at::text as last_activity_at, created_at::text as created_at
      from public.ai_conversation where id = ${id} and org_id = ${ctx.orgId}`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0] ? rowOf(rows[0]) : null;
}

export async function listConversations(
  ctx: Ctx,
  q: { status?: "active" | "archived"; limit: number; offset: number },
): Promise<{ rows: ConversationRow[]; total: number }> {
  const limit = Math.min(Math.max(q.limit, 1), 100);
  const offset = Math.max(q.offset, 0);
  const status = q.status ?? "active";
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, title, kind, agent_id, status, context_refs, message_count, last_run_id::text as last_run_id,
             last_activity_at::text as last_activity_at, created_at::text as created_at
      from public.ai_conversation where org_id = ${ctx.orgId} and user_id = ${ctx.userId} and status = ${status}
      order by last_activity_at desc limit ${limit} offset ${offset}`)) as unknown as Array<
      Record<string, unknown>
    >;
    const total = (await tx.execute(sql`
      select count(*)::int as n from public.ai_conversation
      where org_id = ${ctx.orgId} and user_id = ${ctx.userId} and status = ${status}`)) as unknown as Array<{
      n: number;
    }>;
    return { rows: rows.map(rowOf), total: Number(total[0]?.n ?? 0) };
  });
}

export const UpdateConversationInput = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  agentId: z.enum(AGENT_IDS).optional(),
  status: z.enum(["active", "archived"]).optional(),
  contextRefs: z.array(RecordRefSchema).max(RUN_LIMITS.maxContextRefs).optional(),
});

export async function updateConversation(ctx: Ctx, raw: unknown): Promise<void> {
  const input = UpdateConversationInput.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "idara.conversation.update",
        entityType: "ai_conversation",
        entityId: input.id,
        summary:
          [
            input.title ? "renamed" : null,
            input.agentId ? `agent ${input.agentId}` : null,
            input.status ? input.status : null,
            input.contextRefs ? `${input.contextRefs.length} records shared` : null,
          ]
            .filter(Boolean)
            .join(", ") || "touched",
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.ai_conversation set
          title = coalesce(${input.title ?? null}, title),
          agent_id = coalesce(${input.agentId ?? null}, agent_id),
          status = coalesce(${input.status ?? null}, status),
          context_refs = coalesce(${input.contextRefs ? JSON.stringify(input.contextRefs) : null}::jsonb, context_refs)
        where id = ${input.id} and org_id = ${ctx.orgId} and user_id = ${ctx.userId}`);
      return null;
    },
  );
}

export type MessageRow = {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system" | "tool";
  agentId: AgentId | null;
  blocks: OutputBlock[];
  evidence: RecordRef[];
  runId: string | null;
  provenance: Partial<Provenance>;
  createdAt: string;
};

function asJson<T>(v: unknown, fallback: T): T {
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return (v as T) ?? fallback;
}

function messageOf(r: Record<string, unknown>): MessageRow {
  return {
    id: String(r.id),
    seq: Number(r.seq),
    role: String(r.role) as MessageRow["role"],
    agentId: r.agent_id ? (String(r.agent_id) as AgentId) : null,
    blocks: asJson<OutputBlock[]>(r.blocks, []),
    evidence: asJson<RecordRef[]>(r.evidence, []),
    runId: (r.run_id as string | null) ?? null,
    provenance: asJson<Partial<Provenance>>(r.provenance, {}),
    createdAt: String(r.created_at),
  };
}

/** Messages of a conversation, oldest first, bounded and paged by sequence. */
export async function listMessages(
  ctx: Ctx,
  conversationId: string,
  q: { afterSeq?: number; limit?: number } = {},
): Promise<{ rows: MessageRow[]; total: number }> {
  const limit = Math.min(Math.max(q.limit ?? 60, 1), 200);
  const after = Math.max(q.afterSeq ?? 0, 0);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, seq, role, agent_id, blocks, evidence, run_id::text as run_id, provenance, created_at::text as created_at
      from public.ai_message where org_id = ${ctx.orgId} and conversation_id = ${conversationId} and seq > ${after}
      order by seq asc limit ${limit}`)) as unknown as Array<Record<string, unknown>>;
    const total = (await tx.execute(sql`
      select count(*)::int as n from public.ai_message where org_id = ${ctx.orgId} and conversation_id = ${conversationId}`)) as unknown as Array<{
      n: number;
    }>;
    return { rows: rows.map(messageOf), total: Number(total[0]?.n ?? 0) };
  });
}

/** Append a message inside the caller's transaction; returns its sequence number. */
export async function appendMessageIn(
  tx: TenantTx,
  ctx: Ctx,
  msg: {
    conversationId: string;
    role: MessageRow["role"];
    agentId: AgentId | null;
    blocks: OutputBlock[];
    evidence: RecordRef[];
    runId: string | null;
    provenance: Partial<Provenance>;
  },
): Promise<{ id: string; seq: number }> {
  const id = randomUUID();
  const seqRows = (await tx.execute(sql`
    update public.ai_conversation set message_count = message_count + 1, last_activity_at = now(),
      last_run_id = coalesce(${msg.runId}::uuid, last_run_id)
    where id = ${msg.conversationId} and org_id = ${ctx.orgId} and user_id = ${ctx.userId}
    returning message_count as seq`)) as unknown as Array<{ seq: number }>;
  const seq = Number(seqRows[0]?.seq);
  if (!seq) throw new Error("conversation not found or not owned by the person");
  await tx.execute(sql`
    insert into public.ai_message (id, org_id, conversation_id, seq, role, agent_id, blocks, evidence, run_id, provenance)
    values (${id}, ${ctx.orgId}, ${msg.conversationId}, ${seq}, ${msg.role}, ${msg.agentId}, ${JSON.stringify(msg.blocks)}::jsonb,
            ${JSON.stringify(msg.evidence)}::jsonb, ${msg.runId}, ${JSON.stringify(msg.provenance)}::jsonb)`);
  return { id, seq };
}

/** Branch: a new conversation that copies the transcript up to a message and keeps the context. */
export async function branchConversation(ctx: Ctx, raw: unknown): Promise<ConversationRow> {
  const input = z
    .object({
      conversationId: z.string().uuid(),
      atSeq: z.number().int().min(1),
      title: z.string().trim().max(200).optional(),
    })
    .parse(raw);
  const source = await getConversation(ctx, input.conversationId);
  if (!source) throw new Error("conversation not found");
  const id = randomUUID();
  await command(
    ctx,
    {
      audit: {
        action: "idara.conversation.branch",
        entityType: "ai_conversation",
        entityId: id,
        summary: `branched from ${source.id} at message ${input.atSeq}`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        insert into public.ai_conversation (id, org_id, user_id, title, kind, agent_id, context_refs, branched_from_conversation_id, branched_from_seq)
        values (${id}, ${ctx.orgId}, ${ctx.userId}, ${input.title ?? source.title + " (branch)"}, 'session', ${source.agentId},
                ${JSON.stringify(source.contextRefs)}::jsonb, ${source.id}, ${input.atSeq})`);
      await tx.execute(sql`
        insert into public.ai_message (org_id, conversation_id, seq, role, agent_id, blocks, evidence, run_id, provenance)
        select ${ctx.orgId}, ${id}, seq, role, agent_id, blocks, evidence, run_id, provenance
        from public.ai_message where org_id = ${ctx.orgId} and conversation_id = ${source.id} and seq <= ${input.atSeq}
        order by seq`);
      await tx.execute(sql`
        update public.ai_conversation set message_count = (select count(*) from public.ai_message where conversation_id = ${id} and org_id = ${ctx.orgId})
        where id = ${id} and org_id = ${ctx.orgId}`);
      return null;
    },
  );
  const row = await getConversation(ctx, id);
  if (!row) throw new Error("branch not visible after insert");
  return row;
}
