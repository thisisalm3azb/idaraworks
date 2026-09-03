/**
 * H28 — organisation-authored agents (ADR-53/63): the agent builder.
 *
 * A custom agent is built ON a platform agent and can only narrow it: fewer
 * tools, extra instructions, tighter approvals, a cost ceiling, a model
 * allow-list, availability by role. Instructions are organisation-authored
 * text and therefore carry LOWER authority than the platform contract; they
 * are screened for instruction-hijack shapes and can never widen security,
 * permissions, tool limits or approval rules. Publishing requires a passed
 * evaluation; every published version is an immutable snapshot that can be
 * rolled back to.
 */
import { z } from "zod";
import {
  ACTIVE_AGENT_IDS,
  AGENT_DEFS,
  resolveAgentId,
  type AgentId,
} from "@/platform/agents/registry";
import { AI_MODEL_KEYS } from "@/platform/ai";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { MVP_GRANTABLE_ARCHETYPES, type RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { detectSuspicious } from "./injection";
import { usableTools } from "./tools/registry";

export const CustomAgentDraftSchema = z.object({
  instructions: z.string().trim().max(4000).default(""),
  knowledgeSources: z
    .array(z.string().regex(/^[a-z0-9_.-]{1,80}$/))
    .max(20)
    .default([]),
  allowedTools: z.array(z.string().max(80)).max(60).default([]),
  requiredApprovals: z.array(z.string().max(80)).max(60).default([]),
  availabilityRoles: z
    .array(z.enum(MVP_GRANTABLE_ARCHETYPES))
    .max(7)
    .default([...MVP_GRANTABLE_ARCHETYPES]),
  costCeilingCredits: z.number().int().min(0).max(1_000_000).nullable().default(null),
  modelsAllowed: z.array(z.enum(AI_MODEL_KEYS)).max(20).default([]),
  evalRequired: z.boolean().default(true),
});
export type CustomAgentDraft = z.infer<typeof CustomAgentDraftSchema>;

export const CreateCustomAgentInput = z.object({
  key: z.string().regex(/^[a-z0-9_]{2,40}$/),
  baseAgentId: z.enum(ACTIVE_AGENT_IDS as unknown as [AgentId, ...AgentId[]]),
  nameEn: z.string().trim().min(1).max(80),
  nameAr: z.string().trim().min(1).max(80),
  descriptionEn: z.string().trim().max(500).optional(),
  descriptionAr: z.string().trim().max(500).optional(),
  draft: CustomAgentDraftSchema.optional(),
});

export const UpdateCustomAgentInput = z.object({
  id: z.string().uuid(),
  nameEn: z.string().trim().min(1).max(80).optional(),
  nameAr: z.string().trim().min(1).max(80).optional(),
  descriptionEn: z.string().trim().max(500).optional().nullable(),
  descriptionAr: z.string().trim().max(500).optional().nullable(),
  draft: CustomAgentDraftSchema.partial().optional(),
});

export type CustomAgentRow = {
  id: string;
  key: string;
  baseAgentId: AgentId;
  nameEn: string;
  nameAr: string;
  descriptionEn: string | null;
  descriptionAr: string | null;
  status: "draft" | "published" | "retired";
  publishedVersion: number | null;
  draft: CustomAgentDraft;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type CustomAgentVersionRow = {
  id: string;
  version: number;
  snapshot: CustomAgentDraft & { nameEn: string; nameAr: string; baseAgentId: AgentId };
  evalVersion: string | null;
  evalPassed: boolean | null;
  evalResult: unknown;
  publishedAt: string | null;
  publishedBy: string | null;
  createdBy: string;
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

function rowOf(r: Record<string, unknown>): CustomAgentRow {
  return {
    id: String(r.id),
    key: String(r.key),
    baseAgentId: resolveAgentId(String(r.base_agent_id) as AgentId),
    nameEn: String(r.name_en),
    nameAr: String(r.name_ar),
    descriptionEn: (r.description_en as string | null) ?? null,
    descriptionAr: (r.description_ar as string | null) ?? null,
    status: String(r.status) as CustomAgentRow["status"],
    publishedVersion:
      r.published_version === null || r.published_version === undefined
        ? null
        : Number(r.published_version),
    draft: CustomAgentDraftSchema.parse(asJson<Record<string, unknown>>(r.draft, {})),
    createdBy: String(r.created_by),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

const SELECT = sql`
  select id::text as id, key, base_agent_id, name_en, name_ar, description_en, description_ar, status, published_version, draft,
         created_by::text as created_by, created_at::text as created_at, updated_at::text as updated_at
  from public.ai_agent`;

export class AgentBuilderError extends Error {
  readonly code:
    | "instructions_unsafe"
    | "tool_widening"
    | "base_retired"
    | "eval_required"
    | "not_found"
    | "duplicate_key"
    | "wrong_status";
  readonly details: string[];
  constructor(code: AgentBuilderError["code"], details: string[] = []) {
    super(`agent builder: ${code}`);
    this.code = code;
    this.details = details;
  }
}

/** The narrowing law (ADR-53): a custom agent's tools ⊆ what its base could use for an owner; instructions safe. */
export function validateDraft(
  baseAgentId: AgentId,
  draft: CustomAgentDraft,
): { ok: true } | { ok: false; error: AgentBuilderError } {
  const base = AGENT_DEFS[baseAgentId];
  if (base.status !== "active") return { ok: false, error: new AgentBuilderError("base_retired") };
  const baseTools = new Set(usableTools(baseAgentId, "owner").map((t) => t.id));
  const widening = draft.allowedTools.filter((t) => !baseTools.has(t));
  if (widening.length)
    return { ok: false, error: new AgentBuilderError("tool_widening", widening) };
  const flags = detectSuspicious(draft.instructions, "instructions");
  if (flags.length)
    return {
      ok: false,
      error: new AgentBuilderError(
        "instructions_unsafe",
        flags.map((f) => f.code),
      ),
    };
  const forbidden =
    /\b(ignore|override|bypass|disable)\b[^.\n]{0,40}\b(approval|permission|security|law|rule|confirmation|limit)s?\b/i;
  if (forbidden.test(draft.instructions))
    return {
      ok: false,
      error: new AgentBuilderError("instructions_unsafe", ["override_language"]),
    };
  return { ok: true };
}

export async function createCustomAgent(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<CustomAgentRow> {
  assertCan(archetype, "idara.agents.manage");
  const parsed = CreateCustomAgentInput.parse(raw);
  const input = { ...parsed, draft: CustomAgentDraftSchema.parse(parsed.draft ?? {}) };
  const v = validateDraft(input.baseAgentId, input.draft);
  if (!v.ok) throw v.error;
  const id = await command(
    ctx,
    {
      audit: {
        action: "idara.agent.create",
        entityType: "ai_agent",
        summary: `${input.key} on ${input.baseAgentId}`,
      },
    },
    async (tx) => {
      const dup = (await tx.execute(
        sql`select 1 from public.ai_agent where org_id = ${ctx.orgId} and key = ${input.key}`,
      )) as unknown as unknown[];
      if (dup.length) throw new AgentBuilderError("duplicate_key");
      const rows = (await tx.execute(sql`
        insert into public.ai_agent (org_id, key, base_agent_id, name_en, name_ar, description_en, description_ar, draft, created_by)
        values (${ctx.orgId}, ${input.key}, ${input.baseAgentId}, ${input.nameEn}, ${input.nameAr}, ${input.descriptionEn ?? null}, ${input.descriptionAr ?? null},
                ${JSON.stringify(input.draft)}::jsonb, ${ctx.userId})
        returning id::text as id`)) as unknown as Array<{ id: string }>;
      return rows[0]!.id;
    },
  );
  return (await getCustomAgent(ctx, id))!;
}

export async function getCustomAgent(ctx: Ctx, id: string): Promise<CustomAgentRow | null> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`${SELECT} where id = ${id} and org_id = ${ctx.orgId}`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0] ? rowOf(rows[0]) : null;
}

export async function listCustomAgents(
  ctx: Ctx,
  opts: { includeRetired?: boolean } = {},
): Promise<CustomAgentRow[]> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(
      sql`${SELECT} where org_id = ${ctx.orgId} and (${Boolean(opts.includeRetired)} or status <> 'retired') order by key limit 100`,
    ),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map(rowOf);
}

export async function updateCustomAgent(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<CustomAgentRow> {
  assertCan(archetype, "idara.agents.manage");
  const input = UpdateCustomAgentInput.parse(raw);
  const current = await getCustomAgent(ctx, input.id);
  if (!current) throw new AgentBuilderError("not_found");
  const draft = CustomAgentDraftSchema.parse({ ...current.draft, ...(input.draft ?? {}) });
  const v = validateDraft(current.baseAgentId, draft);
  if (!v.ok) throw v.error;
  await command(
    ctx,
    {
      audit: {
        action: "idara.agent.update",
        entityType: "ai_agent",
        entityId: input.id,
        summary: "draft updated",
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.ai_agent set
          name_en = coalesce(${input.nameEn ?? null}, name_en),
          name_ar = coalesce(${input.nameAr ?? null}, name_ar),
          description_en = case when ${input.descriptionEn === undefined} then description_en else ${input.descriptionEn ?? null} end,
          description_ar = case when ${input.descriptionAr === undefined} then description_ar else ${input.descriptionAr ?? null} end,
          draft = ${JSON.stringify(draft)}::jsonb
        where id = ${input.id} and org_id = ${ctx.orgId}`);
      return null;
    },
  );
  return (await getCustomAgent(ctx, input.id))!;
}

export type EvalOutcome = { version: string; passed: boolean; result: unknown };

/** Publish the draft as a new immutable version; an evaluation must have passed when required. */
export async function publishCustomAgent(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  evalOutcome: EvalOutcome | null,
): Promise<CustomAgentVersionRow> {
  assertCan(archetype, "idara.agents.manage");
  const current = await getCustomAgent(ctx, id);
  if (!current) throw new AgentBuilderError("not_found");
  if (current.status === "retired") throw new AgentBuilderError("wrong_status");
  const v = validateDraft(current.baseAgentId, current.draft);
  if (!v.ok) throw v.error;
  if (current.draft.evalRequired && !(evalOutcome && evalOutcome.passed))
    throw new AgentBuilderError("eval_required");
  const versionId = await command(
    ctx,
    {
      audit: {
        action: "idara.agent.publish",
        entityType: "ai_agent",
        entityId: id,
        summary: `published (eval ${evalOutcome?.version ?? "none"})`,
      },
    },
    async (tx) => {
      const next = (await tx.execute(
        sql`select coalesce(max(version), 0) + 1 as v from public.ai_agent_version where agent_id = ${id} and org_id = ${ctx.orgId}`,
      )) as unknown as Array<{ v: number }>;
      const version = Number(next[0]!.v);
      const snapshot = {
        ...current.draft,
        nameEn: current.nameEn,
        nameAr: current.nameAr,
        baseAgentId: current.baseAgentId,
      };
      const rows = (await tx.execute(sql`
        insert into public.ai_agent_version (org_id, agent_id, version, snapshot, eval_version, eval_passed, eval_result, published_at, published_by, created_by)
        values (${ctx.orgId}, ${id}, ${version}, ${JSON.stringify(snapshot)}::jsonb, ${evalOutcome?.version ?? null}, ${evalOutcome?.passed ?? null},
                ${evalOutcome ? JSON.stringify(evalOutcome.result) : null}::jsonb, now(), ${ctx.userId}, ${ctx.userId})
        returning id::text as id`)) as unknown as Array<{ id: string }>;
      await tx.execute(
        sql`update public.ai_agent set status = 'published', published_version = ${version} where id = ${id} and org_id = ${ctx.orgId}`,
      );
      return rows[0]!.id;
    },
  );
  const versions = await listCustomAgentVersions(ctx, id);
  return versions.find((x) => x.id === versionId)!;
}

export async function listCustomAgentVersions(
  ctx: Ctx,
  id: string,
): Promise<CustomAgentVersionRow[]> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, version, snapshot, eval_version, eval_passed, eval_result, published_at::text as published_at,
             published_by::text as published_by, created_by::text as created_by, created_at::text as created_at
      from public.ai_agent_version where agent_id = ${id} and org_id = ${ctx.orgId} order by version desc limit 50`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    version: Number(r.version),
    snapshot: asJson<CustomAgentVersionRow["snapshot"]>(r.snapshot, {
      ...CustomAgentDraftSchema.parse({}),
      nameEn: "",
      nameAr: "",
      baseAgentId: "idara",
    }),
    evalVersion: (r.eval_version as string | null) ?? null,
    evalPassed:
      r.eval_passed === null || r.eval_passed === undefined ? null : Boolean(r.eval_passed),
    evalResult: asJson<unknown>(r.eval_result, null),
    publishedAt: (r.published_at as string | null) ?? null,
    publishedBy: (r.published_by as string | null) ?? null,
    createdBy: String(r.created_by),
    createdAt: String(r.created_at),
  }));
}

/** Roll back: the published pointer moves to an earlier version and its snapshot becomes the draft again. */
export async function rollbackCustomAgent(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  version: number,
): Promise<CustomAgentRow> {
  assertCan(archetype, "idara.agents.manage");
  const versions = await listCustomAgentVersions(ctx, id);
  const target = versions.find((v) => v.version === version);
  if (!target) throw new AgentBuilderError("not_found");
  const { nameEn, nameAr, baseAgentId, ...draft } = target.snapshot;
  await command(
    ctx,
    {
      audit: {
        action: "idara.agent.rollback",
        entityType: "ai_agent",
        entityId: id,
        summary: `rolled back to v${version}`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.ai_agent set published_version = ${version}, status = 'published', name_en = ${nameEn}, name_ar = ${nameAr},
          draft = ${JSON.stringify(CustomAgentDraftSchema.parse(draft))}::jsonb
        where id = ${id} and org_id = ${ctx.orgId} and base_agent_id = ${baseAgentId}`);
      return null;
    },
  );
  return (await getCustomAgent(ctx, id))!;
}

export async function retireCustomAgent(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<void> {
  assertCan(archetype, "idara.agents.manage");
  await command(
    ctx,
    {
      audit: {
        action: "idara.agent.retire",
        entityType: "ai_agent",
        entityId: id,
        summary: "retired",
      },
    },
    async (tx) => {
      await tx.execute(
        sql`update public.ai_agent set status = 'retired' where id = ${id} and org_id = ${ctx.orgId}`,
      );
      return null;
    },
  );
}

/** The published definition the run engine applies (null when unpublished or unavailable to the role). */
export async function publishedCustomAgentIn(
  tx: TenantTx,
  ctx: Ctx,
  id: string,
  archetype: RoleArchetype,
): Promise<{
  row: CustomAgentRow;
  snapshot: CustomAgentVersionRow["snapshot"];
  version: number;
} | null> {
  const rows = (await tx.execute(
    sql`${SELECT} where id = ${id} and org_id = ${ctx.orgId} and status = 'published'`,
  )) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) return null;
  const row = rowOf(rows[0]);
  if (row.publishedVersion === null) return null;
  const vs = (await tx.execute(sql`
    select snapshot from public.ai_agent_version where agent_id = ${id} and org_id = ${ctx.orgId} and version = ${row.publishedVersion}`)) as unknown as Array<{
    snapshot: unknown;
  }>;
  if (!vs[0]) return null;
  const snapshot = asJson<CustomAgentVersionRow["snapshot"]>(vs[0].snapshot, {
    ...CustomAgentDraftSchema.parse({}),
    nameEn: row.nameEn,
    nameAr: row.nameAr,
    baseAgentId: row.baseAgentId,
  });
  if (!snapshot.availabilityRoles.includes(archetype as never)) return null;
  return { row, snapshot, version: row.publishedVersion };
}

// ── platform agent state per organisation ───────────────────────────────────

export async function setAgentState(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "idara.agents.manage");
  const input = z
    .object({
      agentId: z.enum(ACTIVE_AGENT_IDS as unknown as [AgentId, ...AgentId[]]),
      enabled: z.boolean(),
      reason: z.string().trim().max(500).optional(),
    })
    .parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "idara.agent.state",
        entityType: "ai_agent",
        summary: `${input.agentId} enabled=${input.enabled}${input.reason ? `: ${input.reason}` : ""}`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        insert into public.ai_agent_state (org_id, agent_id, enabled, reason, set_by, set_at)
        values (${ctx.orgId}, ${input.agentId}, ${input.enabled}, ${input.reason ?? null}, ${ctx.userId}, now())
        on conflict (org_id, agent_id) do update set enabled = excluded.enabled, reason = excluded.reason, set_by = excluded.set_by, set_at = now()`);
      return null;
    },
  );
}

export async function agentStatesIn(tx: TenantTx, ctx: Ctx): Promise<Record<string, boolean>> {
  const rows = (await tx.execute(
    sql`select agent_id, enabled from public.ai_agent_state where org_id = ${ctx.orgId}`,
  )) as unknown as Array<{ agent_id: string; enabled: boolean }>;
  const out: Record<string, boolean> = {};
  for (const id of ACTIVE_AGENT_IDS) out[id] = AGENT_DEFS[id].defaultEnabled;
  for (const r of rows) out[r.agent_id] = Boolean(r.enabled);
  return out;
}

export async function agentStates(ctx: Ctx): Promise<Record<string, boolean>> {
  return withCtx(ctx, (tx) => agentStatesIn(tx, ctx));
}

/** Templates administrators can start from (safe, narrow, documented). */
export const AGENT_TEMPLATES: Array<{
  key: string;
  baseAgentId: AgentId;
  nameEn: string;
  nameAr: string;
  instructions: string;
  allowedTools: string[];
}> = [
  {
    key: "collections_helper",
    baseAgentId: "customer_success",
    nameEn: "Collections helper",
    nameAr: "مساعد التحصيل",
    instructions:
      "Focus on overdue receivables. For each customer summarise the overdue amount, the age and the last recorded contact, then draft a polite reminder for a person to send.",
    allowedTools: ["customer.overview", "finance.ar_ageing", "sales.my_queue"],
  },
  {
    key: "morning_operations",
    baseAgentId: "operations",
    nameEn: "Morning operations check",
    nameAr: "فحص العمليات الصباحي",
    instructions:
      "Every answer starts with what is blocked or late today, then what needs a decision. Keep it under ten lines.",
    allowedTools: ["exceptions.open", "work.week", "inventory.attention"],
  },
  {
    key: "contract_reader",
    baseAgentId: "document_contract",
    nameEn: "Contract reader",
    nameAr: "قارئ العقود",
    instructions:
      "Summarise payment terms, termination clauses and obligations with exact clause citations. Say when a clause is missing.",
    allowedTools: ["documents.list", "documents.detail"],
  },
];
