/**
 * H28 — explicit, governed memory (ADR-62).
 *
 * Rows exist only through an explicit "remember" action by the person (scope
 * user) or an administrator (scope org). Conversation content is never
 * promoted silently. Every row shows its source, author and date; owners can
 * correct or revoke; memories enter prompts as labelled blocks, never as
 * instructions.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";

export type MemoryRow = {
  id: string;
  scope: "user" | "org";
  kind: "preference" | "knowledge";
  key: string;
  value: unknown;
  source: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

const KEY = z.string().regex(/^[a-z0-9_.-]{1,80}$/);

export const RememberInput = z.object({
  scope: z.enum(["user", "org"]).default("user"),
  kind: z.enum(["preference", "knowledge"]).default("preference"),
  key: KEY,
  value: z.unknown(),
  source: z.string().trim().max(200).optional(),
});

/** Preference keys the platform understands (others are free-form knowledge for prompts). */
export const KNOWN_PREFERENCES = [
  "dock.shortcut",
  "dock.position",
  "answer.length",
  "answer.language",
  "agent.default",
  "briefing.time",
] as const;

function rowOf(r: Record<string, unknown>): MemoryRow {
  return {
    id: String(r.id),
    scope: String(r.scope) as MemoryRow["scope"],
    kind: String(r.kind) as MemoryRow["kind"],
    key: String(r.key),
    value: typeof r.value === "string" ? safeJson(r.value) : r.value,
    source: (r.source as string | null) ?? null,
    createdBy: String(r.created_by),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function safeJson(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export async function remember(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<MemoryRow> {
  const input = RememberInput.parse(raw);
  if (input.scope === "org") assertCan(archetype, "config.manage");
  const encoded = JSON.stringify(input.value ?? null);
  if (encoded.length > 4000) throw new Error("memory value too large");
  const id = await command(
    ctx,
    {
      audit: {
        action: "idara.memory.remember",
        entityType: "ai_memory",
        summary: `${input.scope} ${input.kind} ${input.key}`,
      },
    },
    async (tx) => {
      // Correcting: revoke the live row for the key, then insert the new one.
      await tx.execute(sql`
        update public.ai_memory set revoked_at = now(), revoked_by = ${ctx.userId}
        where org_id = ${ctx.orgId} and scope = ${input.scope} and key = ${input.key} and revoked_at is null
          and (scope = 'org' or user_id = ${ctx.userId})`);
      const rows = (await tx.execute(sql`
        insert into public.ai_memory (org_id, scope, user_id, kind, key, value, source, created_by)
        values (${ctx.orgId}, ${input.scope}, ${input.scope === "user" ? ctx.userId : null}, ${input.kind}, ${input.key},
                ${encoded}::jsonb, ${input.source ?? "explicit"}, ${ctx.userId})
        returning id::text as id`)) as unknown as Array<{ id: string }>;
      return rows[0]!.id;
    },
  );
  const row = await getMemory(ctx, id);
  if (!row) throw new Error("memory not visible after insert");
  return row;
}

export async function getMemory(ctx: Ctx, id: string): Promise<MemoryRow | null> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, scope, kind, key, value, source, created_by::text as created_by, created_at::text as created_at, updated_at::text as updated_at
      from public.ai_memory where id = ${id} and org_id = ${ctx.orgId} and revoked_at is null`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0] ? rowOf(rows[0]) : null;
}

export async function listMemory(ctx: Ctx, scope?: "user" | "org"): Promise<MemoryRow[]> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, scope, kind, key, value, source, created_by::text as created_by, created_at::text as created_at, updated_at::text as updated_at
      from public.ai_memory where org_id = ${ctx.orgId} and revoked_at is null
        and (${scope ?? null}::text is null or scope = ${scope ?? null})
        and (scope = 'org' or user_id = ${ctx.userId})
      order by scope, key limit 200`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map(rowOf);
}

export async function forget(ctx: Ctx, archetype: RoleArchetype, id: string): Promise<void> {
  const row = await getMemory(ctx, id);
  if (!row) return;
  if (row.scope === "org") assertCan(archetype, "config.manage");
  await command(
    ctx,
    {
      audit: {
        action: "idara.memory.forget",
        entityType: "ai_memory",
        entityId: row.id,
        summary: `${row.scope} ${row.key} revoked`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.ai_memory set revoked_at = now(), revoked_by = ${ctx.userId}
        where id = ${id} and org_id = ${ctx.orgId} and revoked_at is null`);
      return null;
    },
  );
}

/** Memories as prompt material: labelled data, bounded, never instructions. */
export async function memoryBlockIn(
  tx: TenantTx,
  ctx: Ctx,
): Promise<{
  preferences: Record<string, unknown>;
  knowledge: Array<{ key: string; value: unknown; source: string | null }>;
}> {
  const rows = (await tx.execute(sql`
    select scope, kind, key, value, source from public.ai_memory
    where org_id = ${ctx.orgId} and revoked_at is null and (scope = 'org' or user_id = ${ctx.userId})
    order by scope, key limit 60`)) as unknown as Array<Record<string, unknown>>;
  const preferences: Record<string, unknown> = {};
  const knowledge: Array<{ key: string; value: unknown; source: string | null }> = [];
  for (const r of rows) {
    const value = typeof r.value === "string" ? safeJson(r.value) : r.value;
    if (r.kind === "preference") preferences[String(r.key)] = value;
    else knowledge.push({ key: String(r.key), value, source: (r.source as string | null) ?? null });
  }
  return { preferences, knowledge };
}

/** One preference read for the dock (shortcut, default agent). */
export async function preference(ctx: Ctx, key: string): Promise<unknown | null> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select value from public.ai_memory where org_id = ${ctx.orgId} and scope = 'user' and user_id = ${ctx.userId}
        and kind = 'preference' and key = ${key} and revoked_at is null limit 1`),
  )) as unknown as Array<{ value: unknown }>;
  const v = rows[0]?.value;
  return v === undefined ? null : typeof v === "string" ? safeJson(v) : v;
}
