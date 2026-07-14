/**
 * Customer progress updates + the tokenized share surface (doc 04 F-22; doc 01 customer_update).
 * A draft is composed (AI-drafted OR manually written — send is ALWAYS a human action), then
 * SENT: sending freezes a safe-by-construction `content` snapshot (stage completions, progress %,
 * next milestones — NEVER costs/labour/margin/internal issues/other customers) and mints a
 * share_token (≥128-bit random; only its SHA-256 hash is stored). The public page reads through
 * the app.resolve_share_token DEFINER, the one no-auth path. Tokens are org-revocable + expiring
 * (PB-5 "revocable web link"). Every mutation runs through command()+audit; no hard deletes.
 */
import { z } from "zod";
import { randomBytes, createHash } from "node:crypto";
import { sql, withCtx, createAppDb, type Ctx, type TenantTx } from "@/platform/tenancy";
import { command } from "@/platform/audit/command";
import { assertCan, type Action } from "@/platform/authz";
import { requireCapability } from "@/platform/entitlements";
import type { RoleArchetype } from "@/platform/registries";
import { CUSTOMER_UPDATE_SENT, SHARE_TOKEN_CREATED, SHARE_TOKEN_REVOKED } from "@/platform/events";

const SHARE_TTL_DAYS = 90; // default; org/template-tunable later

export class CustomerUpdateNotFoundError extends Error {
  constructor() {
    super("customer update not found");
    this.name = "CustomerUpdateNotFoundError";
  }
}
export class CustomerUpdateStateError extends Error {
  constructor(msg = "customer update is not in the required state") {
    super(msg);
    this.name = "CustomerUpdateStateError";
  }
}

export const CreateDraftInput = z.object({
  jobId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4000),
  language: z.enum(["en", "ar"]).default("ar"),
  aiDrafted: z.boolean().default(false),
});

export async function createDraft(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "customer_updates.draft" as Action);
  // Add-on gate (FR-9): CREATE only — reads and editing an existing draft never gate.
  await requireCapability(ctx, "cap.customer_updates");
  const input = CreateDraftInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "customer_update.create",
        entityType: "customer_update",
        entityId: r.id,
        summary: `Drafted customer update: ${input.title}`,
      }),
    },
    async (tx) => {
      const snap = input.jobId ? await jobSnapshot(tx, ctx, input.jobId) : null;
      const custName = input.customerId ? await customerName(tx, ctx, input.customerId) : null;
      const rows = (await tx.execute(sql`
        insert into public.customer_update
          (org_id, job_id, job_name, customer_id, customer_name, title, language, body, ai_drafted, created_by)
        values (${ctx.orgId}, ${input.jobId ?? null}, ${snap?.name ?? null}, ${input.customerId ?? null},
                ${custName}, ${input.title}, ${input.language}, ${input.body}, ${input.aiDrafted}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export const UpdateDraftInput = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(4000).optional(),
  language: z.enum(["en", "ar"]).optional(),
});

export async function updateDraft(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "customer_updates.draft" as Action);
  const input = UpdateDraftInput.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "customer_update.edit",
        entityType: "customer_update",
        entityId: id,
        summary: "Edited customer update draft",
      },
    },
    async (tx) => {
      // Draft-only edit enforced by RLS; the guarded UPDATE also detects a no-op.
      const rows = (await tx.execute(sql`
        update public.customer_update set
          title = coalesce(${input.title ?? null}, title),
          body = coalesce(${input.body ?? null}, body),
          language = coalesce(${input.language ?? null}, language),
          updated_at = now()
        where id = ${id} and org_id = ${ctx.orgId} and status = 'draft'
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new CustomerUpdateStateError("only a draft update can be edited");
    },
  );
}

/**
 * Deterministic "suggested body" from the job's own facts — the manual-fallback draft when
 * AI is not configured (send is still human). No costs. A real AI draft (feat.ai_drafts +
 * credits) would replace this text; the safe fact set is identical either way.
 */
export async function suggestBody(
  ctx: Ctx,
  archetype: RoleArchetype,
  jobId: string,
  lang: "en" | "ar",
): Promise<{ title: string; body: string }> {
  assertCan(archetype, "customer_updates.draft" as Action);
  return withCtx(ctx, async (tx) => {
    const content = await safeContent(tx, ctx, jobId);
    const ref = content.reference ?? "";
    if (lang === "ar") {
      const stages = content.stagesCompleted.map((s) => s.ar).join("، ");
      return {
        title: `تحديث المشروع ${ref}`.trim(),
        body:
          `نودّ إطلاعكم على آخر مستجدات مشروعكم. ` +
          (stages ? `المراحل المكتملة: ${stages}. ` : "") +
          `نسبة الإنجاز: ${content.progressPct ?? 0}%. نشكر ثقتكم.`,
      };
    }
    const stages = content.stagesCompleted.map((s) => s.en).join(", ");
    return {
      title: `Project update ${ref}`.trim(),
      body:
        `Here is the latest on your project. ` +
        (stages ? `Completed so far: ${stages}. ` : "") +
        `Progress: ${content.progressPct ?? 0}%. Thank you for your trust.`,
    };
  });
}

/**
 * SEND: freeze the safe snapshot, mark sent, and mint a share token. Returns the RAW token
 * ONCE (never stored) so the caller can build the link. Emits the outbox facts.
 */
export async function sendUpdate(
  ctx: Ctx,
  archetype: RoleArchetype,
  id: string,
): Promise<{ shareTokenId: string; token: string; expiresAt: string }> {
  assertCan(archetype, "customer_updates.send" as Action);
  // SEND publishes to the customer — gated like create (FR-9); revoke stays ungated.
  await requireCapability(ctx, "cap.customer_updates");
  const rawToken = randomBytes(32).toString("base64url"); // 256-bit
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const result = await command<{ shareTokenId: string; expiresAt: string }>(
    ctx,
    {
      audit: {
        action: "customer_update.send",
        entityType: "customer_update",
        entityId: id,
        summary: "Sent customer update + minted share link",
      },
      events: (r) => [
        { name: CUSTOMER_UPDATE_SENT, payload: { customerUpdateId: id } },
        {
          name: SHARE_TOKEN_CREATED,
          payload: { shareTokenId: r.shareTokenId, customerUpdateId: id },
        },
      ],
    },
    async (tx) => {
      const meta = (await tx.execute(sql`
        select status, job_id::text as job_id from public.customer_update
        where id = ${id} and org_id = ${ctx.orgId}
      `)) as unknown as Array<{ status: string; job_id: string | null }>;
      if (!meta[0]) throw new CustomerUpdateNotFoundError();
      if (meta[0].status !== "draft")
        throw new CustomerUpdateStateError("only a draft can be sent");
      const content = meta[0].job_id ? await safeContent(tx, ctx, meta[0].job_id) : emptyContent();
      const sent = (await tx.execute(sql`
        update public.customer_update
        set status = 'sent', content = ${JSON.stringify(content)}::jsonb, sent_at = now(), updated_at = now()
        where id = ${id} and org_id = ${ctx.orgId} and status = 'draft'
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (!sent[0]) throw new CustomerUpdateStateError("update is no longer sendable");
      const expiresAt = new Date(Date.now() + SHARE_TTL_DAYS * 86_400_000).toISOString();
      const tok = (await tx.execute(sql`
        insert into public.share_token (org_id, customer_update_id, token_hash, expires_at, created_by)
        values (${ctx.orgId}, ${id}, ${tokenHash}, ${expiresAt}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { shareTokenId: tok[0]!.id, expiresAt };
    },
  );
  return { shareTokenId: result.shareTokenId, token: rawToken, expiresAt: result.expiresAt };
}

/** Revoke a live share token (org-revocable, F-22). The public page then returns not-found. */
export async function revokeShare(
  ctx: Ctx,
  archetype: RoleArchetype,
  shareTokenId: string,
): Promise<void> {
  assertCan(archetype, "customer_updates.revoke" as Action);
  await command(
    ctx,
    {
      audit: {
        action: "share_token.revoke",
        entityType: "share_token",
        entityId: shareTokenId,
        summary: "Revoked a customer share link",
      },
      events: [{ name: SHARE_TOKEN_REVOKED, payload: { shareTokenId } }],
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        update public.share_token set revoked_at = now(), revoked_by = ${ctx.userId}
        where id = ${shareTokenId} and org_id = ${ctx.orgId} and revoked_at is null
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (!rows[0]) throw new CustomerUpdateStateError("token already revoked or not found");
    },
  );
}

export type CustomerUpdateRow = {
  id: string;
  title: string;
  status: string;
  jobName: string | null;
  customerName: string | null;
  createdAt: string;
};

export async function listUpdates(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<CustomerUpdateRow[]> {
  assertCan(archetype, "customer_updates.draft" as Action);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, title, status, job_name, customer_name, created_at::text as created_at
      from public.customer_update where org_id = ${ctx.orgId}
      order by created_at desc limit 200
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      title: r.title as string,
      status: r.status as string,
      jobName: (r.job_name as string | null) ?? null,
      customerName: (r.customer_name as string | null) ?? null,
      createdAt: r.created_at as string,
    }));
  });
}

export async function getUpdate(ctx: Ctx, archetype: RoleArchetype, id: string) {
  assertCan(archetype, "customer_updates.draft" as Action);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select cu.id::text as id, cu.title, cu.body, cu.language, cu.status, cu.job_name, cu.customer_name,
             cu.content, cu.sent_at::text as sent_at,
             (select id::text from public.share_token st
              where st.customer_update_id = cu.id and st.org_id = ${ctx.orgId}
                and st.revoked_at is null and st.expires_at > now()
              order by st.created_at desc limit 1) as live_token_id
      from public.customer_update cu where cu.id = ${id} and cu.org_id = ${ctx.orgId}
    `)) as unknown as Array<Record<string, unknown>>;
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id as string,
      title: r.title as string,
      body: r.body as string,
      language: r.language as string,
      status: r.status as string,
      jobName: (r.job_name as string | null) ?? null,
      customerName: (r.customer_name as string | null) ?? null,
      content: (r.content as unknown) ?? null,
      sentAt: (r.sent_at as string | null) ?? null,
      liveTokenId: (r.live_token_id as string | null) ?? null,
    };
  });
}

/**
 * PUBLIC resolve — the no-auth path. Hash the presented raw token and call the DEFINER
 * resolver on a NO-CONTEXT app client; it returns only the safe snapshot of an ACTIVE token's
 * sent update (or nothing). Returns null for any invalid/expired/revoked token — the caller
 * renders an identical "not available" page (no org/subject id ever leaks).
 */
export async function resolvePublicShare(rawToken: string): Promise<{
  title: string;
  language: string;
  body: string;
  content: unknown;
  sentAt: string | null;
} | null> {
  if (!rawToken || rawToken.length < 16 || rawToken.length > 128) return null;
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const { db, end } = createAppDb({ max: 1 });
  try {
    const rows = (await db.execute(sql`
      select title, language, body, content, sent_at::text as sent_at
      from app.resolve_share_token(${tokenHash})
    `)) as unknown as Array<Record<string, unknown>>;
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      title: r.title as string,
      language: r.language as string,
      body: r.body as string,
      content: (r.content as unknown) ?? null,
      sentAt: (r.sent_at as string | null) ?? null,
    };
  } finally {
    await end();
  }
}

// ── safe-by-construction content snapshot ────────────────────────────────────────
type SafeContent = {
  reference: string | null;
  progressPct: number | null;
  stagesCompleted: Array<{ key: string; en: string; ar: string }>;
  nextMilestones: Array<{ en: string; ar: string }>;
  photoFileIds: string[];
};

function emptyContent(): SafeContent {
  return {
    reference: null,
    progressPct: null,
    stagesCompleted: [],
    nextMilestones: [],
    photoFileIds: [],
  };
}

/** Build the client-safe snapshot from job facts — NO cost/labour/margin/internal fields. */
async function safeContent(tx: TenantTx, ctx: Ctx, jobId: string): Promise<SafeContent> {
  const jobRows = (await tx.execute(sql`
    select reference from public.job where id = ${jobId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{ reference: string }>;
  const stages = (await tx.execute(sql`
    select stage_key, name, status, weight from public.job_stage
    where job_id = ${jobId} and org_id = ${ctx.orgId} order by sort
  `)) as unknown as Array<{
    stage_key: string;
    name: { en?: string; ar?: string };
    status: string;
    weight: number;
  }>;
  const completed = stages
    .filter((s) => s.status === "completed")
    .map((s) => ({ key: s.stage_key, en: s.name.en ?? s.stage_key, ar: s.name.ar ?? s.stage_key }));
  const next = stages
    .filter((s) => s.status === "not_started" || s.status === "in_progress")
    .slice(0, 2)
    .map((s) => ({ en: s.name.en ?? s.stage_key, ar: s.name.ar ?? s.stage_key }));
  const denom = stages.filter((s) => s.status !== "skipped").reduce((a, s) => a + s.weight, 0);
  const num = stages
    .filter((s) => s.status !== "skipped")
    .reduce(
      (a, s) =>
        a + s.weight * (s.status === "completed" ? 1 : s.status === "in_progress" ? 0.5 : 0),
      0,
    );
  const progressPct = denom === 0 ? null : Math.round((num / denom) * 1000) / 10;
  return {
    reference: jobRows[0]?.reference ?? null,
    progressPct,
    stagesCompleted: completed,
    nextMilestones: next,
    photoFileIds: [],
  };
}

async function jobSnapshot(tx: TenantTx, ctx: Ctx, jobId: string) {
  const rows = (await tx.execute(sql`
    select name from public.job where id = ${jobId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{ name: string }>;
  return rows[0] ? { name: rows[0].name } : null;
}
async function customerName(tx: TenantTx, ctx: Ctx, customerId: string) {
  const rows = (await tx.execute(sql`
    select name from public.customer where id = ${customerId} and org_id = ${ctx.orgId}
  `)) as unknown as Array<{ name: string }>;
  return rows[0]?.name ?? null;
}
