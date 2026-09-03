/**
 * H28 — proactive schedules (ADR-65): a schedule of agent runs, never a rule
 * engine. Each schedule names a kind (closed list), an agent, a cadence and
 * recipients by role. The sweep creates a background run per due schedule,
 * executes it under the organisation's owner (the same actor attribution the
 * H27 sweep uses), saves the result as a report, deduplicates by content
 * hash inside the window, and notifies recipients through the existing
 * notification kinds while respecting each person's mute and snooze.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { ACTIVE_AGENT_IDS, type AgentId } from "@/platform/agents/registry";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { idaraEnabled } from "@/platform/flags";
import { normalizeLocale } from "@/platform/i18n";
import { logger } from "@/platform/logger";
import { createNotificationIn } from "@/platform/notifications";
import type { RoleArchetype } from "@/platform/registries";
import { createAppDb, sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { getConversation, listMessages, startConversation } from "./conversations";
import { executeRun, startRun } from "./runs";
import type { OutputBlock } from "./types";

export const SCHEDULE_KINDS = [
  "management_briefing",
  "stalled_opportunities",
  "project_risk_digest",
  "renewal_reminders",
  "missing_evidence",
  "stock_reorder_proposal",
  "variance_alert",
  "payroll_input_reminder",
  "meeting_brief",
] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** The agent and the request each kind runs (trusted text; records arrive through tools). */
export const SCHEDULE_DEFS: Record<
  ScheduleKind,
  { agent: AgentId; prompt: string; outputKind: "report" | "analysis" | "meeting_brief" }
> = {
  management_briefing: {
    agent: "executive",
    prompt:
      "Prepare today's management briefing: what needs attention across delivery, money, customers and people, with the records that show it.",
    outputKind: "report",
  },
  stalled_opportunities: {
    agent: "sales_crm",
    prompt:
      "Summarise stalled opportunities and overdue follow-ups, most valuable first, with the evidence and a suggested next step each.",
    outputKind: "report",
  },
  project_risk_digest: {
    agent: "project",
    prompt:
      "Digest the schedule risks across active plans: late tasks, critical-path slips and resource conflicts, with evidence.",
    outputKind: "report",
  },
  renewal_reminders: {
    agent: "customer_success",
    prompt:
      "List agreements and customers due for renewal in the coming weeks with their health signals and evidence.",
    outputKind: "report",
  },
  missing_evidence: {
    agent: "accounting",
    prompt:
      "List entries, returns and reconciliations that lack supporting evidence, with what is missing for each.",
    outputKind: "report",
  },
  stock_reorder_proposal: {
    agent: "inventory_purchasing",
    prompt:
      "Propose reorders for items at or below their reorder points, with current stock, movements and the evidence.",
    outputKind: "analysis",
  },
  variance_alert: {
    agent: "finance",
    prompt:
      "Report unusual variances against budgets and prior periods with the entries that explain them.",
    outputKind: "analysis",
  },
  payroll_input_reminder: {
    agent: "people_payroll",
    prompt:
      "List the inputs still missing before the next payroll run can be calculated, per employee where permitted.",
    outputKind: "report",
  },
  meeting_brief: {
    agent: "sales_crm",
    prompt:
      "Draft a meeting brief for the customers with meetings or follow-ups due this week: history, open items and suggested talking points.",
    outputKind: "meeting_brief",
  },
};

export const ScheduleInput = z.object({
  kind: z.enum(SCHEDULE_KINDS),
  agentId: z.enum(ACTIVE_AGENT_IDS as unknown as [AgentId, ...AgentId[]]).optional(),
  cadence: z.enum(["daily", "weekly"]).default("daily"),
  hourLocal: z.number().int().min(0).max(23).default(8),
  weekday: z.number().int().min(0).max(6).nullable().default(null),
  recipients: z.array(z.string().max(20)).max(7).default(["owner", "admin", "manager"]),
  enabled: z.boolean().default(false),
  dedupWindowHours: z.number().int().min(1).max(720).default(24),
});

export type ScheduleRow = {
  id: string;
  kind: ScheduleKind;
  agentId: AgentId;
  cadence: "daily" | "weekly";
  hourLocal: number;
  weekday: number | null;
  recipients: string[];
  enabled: boolean;
  dedupWindowHours: number;
  lastRunAt: string | null;
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

function rowOf(r: Record<string, unknown>): ScheduleRow {
  return {
    id: String(r.id),
    kind: String(r.kind) as ScheduleKind,
    agentId: String(r.agent_id) as AgentId,
    cadence: String(r.cadence) as "daily" | "weekly",
    hourLocal: Number(r.hour_local),
    weekday: r.weekday === null || r.weekday === undefined ? null : Number(r.weekday),
    recipients: asJson<string[]>(r.recipients, []),
    enabled: Boolean(r.enabled),
    dedupWindowHours: Number(r.dedup_window_hours),
    lastRunAt: (r.last_run_at as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}

const SELECT = sql`
  select id::text as id, kind, agent_id, cadence, hour_local, weekday, recipients, enabled, dedup_window_hours,
         last_run_at::text as last_run_at, created_at::text as created_at
  from public.ai_schedule`;

export async function listSchedules(ctx: Ctx): Promise<ScheduleRow[]> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`${SELECT} where org_id = ${ctx.orgId} order by kind`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map(rowOf);
}

export async function upsertSchedule(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<ScheduleRow> {
  assertCan(archetype, "idara.agents.manage");
  const input = ScheduleInput.parse(raw);
  const agentId = input.agentId ?? SCHEDULE_DEFS[input.kind].agent;
  await command(
    ctx,
    {
      audit: {
        action: "idara.schedule.upsert",
        entityType: "ai_schedule",
        summary: `${input.kind} ${input.cadence} ${input.enabled ? "enabled" : "disabled"}`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        insert into public.ai_schedule (org_id, kind, agent_id, cadence, hour_local, weekday, recipients, enabled, dedup_window_hours, created_by)
        values (${ctx.orgId}, ${input.kind}, ${agentId}, ${input.cadence}, ${input.hourLocal}, ${input.weekday}, ${JSON.stringify(input.recipients)}::jsonb,
                ${input.enabled}, ${input.dedupWindowHours}, ${ctx.userId})
        on conflict (org_id, kind) do update set agent_id = excluded.agent_id, cadence = excluded.cadence, hour_local = excluded.hour_local,
          weekday = excluded.weekday, recipients = excluded.recipients, enabled = excluded.enabled, dedup_window_hours = excluded.dedup_window_hours`);
      return null;
    },
  );
  const rows = await listSchedules(ctx);
  return rows.find((r) => r.kind === input.kind)!;
}

export const SchedulePrefInput = z.object({
  scheduleId: z.string().uuid(),
  muted: z.boolean().optional(),
  snoozedUntil: z.string().datetime().nullable().optional(),
  frequency: z.enum(["every", "daily", "weekly"]).optional(),
});

export async function setSchedulePref(ctx: Ctx, raw: unknown): Promise<void> {
  const input = SchedulePrefInput.parse(raw);
  await withCtx(ctx, (tx) =>
    tx.execute(sql`
      insert into public.ai_schedule_pref (org_id, schedule_id, user_id, muted, snoozed_until, frequency)
      values (${ctx.orgId}, ${input.scheduleId}, ${ctx.userId}, ${input.muted ?? false}, ${input.snoozedUntil ?? null}, ${input.frequency ?? "every"})
      on conflict (org_id, schedule_id, user_id) do update set
        muted = coalesce(${input.muted ?? null}, public.ai_schedule_pref.muted),
        snoozed_until = case when ${input.snoozedUntil === undefined} then public.ai_schedule_pref.snoozed_until else ${input.snoozedUntil ?? null} end,
        frequency = coalesce(${input.frequency ?? null}, public.ai_schedule_pref.frequency),
        updated_at = now()`),
  );
}

export async function mySchedulePrefs(
  ctx: Ctx,
): Promise<
  Array<{ scheduleId: string; muted: boolean; snoozedUntil: string | null; frequency: string }>
> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(
      sql`select schedule_id::text as schedule_id, muted, snoozed_until::text as snoozed_until, frequency from public.ai_schedule_pref where org_id = ${ctx.orgId} and user_id = ${ctx.userId}`,
    ),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    scheduleId: String(r.schedule_id),
    muted: Boolean(r.muted),
    snoozedUntil: (r.snoozed_until as string | null) ?? null,
    frequency: String(r.frequency),
  }));
}

/** Pure: is the schedule due at `now` in the organisation's timezone? */
export function scheduleDue(
  s: {
    cadence: "daily" | "weekly";
    hourLocal: number;
    weekday: number | null;
    lastRunAt: string | null;
    enabled: boolean;
  },
  now: Date,
  timeZone: string,
): boolean {
  if (!s.enabled) return false;
  let local: { hour: number; weekday: number; day: string };
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    local = {
      hour: Number(get("hour")) % 24,
      weekday: weekdays.indexOf(get("weekday")),
      day: `${get("year")}-${get("month")}-${get("day")}`,
    };
  } catch {
    local = {
      hour: now.getUTCHours(),
      weekday: now.getUTCDay(),
      day: now.toISOString().slice(0, 10),
    };
  }
  if (local.hour < s.hourLocal) return false;
  if (s.cadence === "weekly" && s.weekday !== null && local.weekday !== s.weekday) return false;
  if (!s.lastRunAt) return true;
  const last = new Date(s.lastRunAt);
  const gapHours = (now.getTime() - last.getTime()) / 3_600_000;
  return s.cadence === "daily" ? gapHours >= 20 : gapHours >= 6 * 24;
}

function contentHash(blocks: OutputBlock[]): string {
  const stable = blocks
    .filter((b) => b.kind !== "notice")
    .map((b) => JSON.stringify(b))
    .join("\n");
  return createHash("sha256").update(stable).digest("hex");
}

/** Run every due schedule of one organisation (called by the sweep under the owner's ctx). */
export async function runDueSchedules(
  ctx: Ctx,
  archetype: RoleArchetype,
  now: Date = new Date(),
): Promise<{ due: number; ran: number; deduplicated: number; notified: number }> {
  const out = { due: 0, ran: 0, deduplicated: 0, notified: 0 };
  const org = (await withCtx(ctx, (tx) =>
    tx.execute(sql`select timezone from public.org where id = ${ctx.orgId}`),
  )) as unknown as Array<{ timezone: string | null }>;
  const tz = org[0]?.timezone ?? "Asia/Dubai";
  const schedules = await listSchedules(ctx);
  for (const s of schedules) {
    if (!scheduleDue(s, now, tz)) continue;
    out.due++;
    const def = SCHEDULE_DEFS[s.kind];
    const conversation = await startConversation(ctx, {
      kind: "session",
      agentId: s.agentId,
      title: `${s.kind} ${now.toISOString().slice(0, 10)}`,
    });
    const started = await startRun(ctx, archetype, normalizeLocale("en"), {
      conversationId: conversation.id,
      input: def.prompt,
      agentId: s.agentId,
      kind: "background",
    });
    const run = await executeRun(ctx, archetype, normalizeLocale("en"), started.runId);
    out.ran++;
    const msgs = await listMessages(ctx, conversation.id, { limit: 5 });
    const answer = msgs.rows.find((m) => m.role === "assistant");
    const hash = answer ? contentHash(answer.blocks) : null;
    const prev = (await withCtx(ctx, (tx) =>
      tx.execute(
        sql`select last_content_hash, last_run_at::text as last_run_at from public.ai_schedule where id = ${s.id} and org_id = ${ctx.orgId}`,
      ),
    )) as unknown as Array<{ last_content_hash: string | null; last_run_at: string | null }>;
    const withinWindow = prev[0]?.last_run_at
      ? (now.getTime() - new Date(prev[0].last_run_at).getTime()) / 3_600_000 < s.dedupWindowHours
      : false;
    const duplicate = Boolean(hash && prev[0]?.last_content_hash === hash && withinWindow);
    await withCtx(ctx, (tx) =>
      tx.execute(
        sql`update public.ai_schedule set last_run_at = now(), last_content_hash = ${hash} where id = ${s.id} and org_id = ${ctx.orgId}`,
      ),
    );
    if (run.status !== "completed" || !answer) continue;
    if (duplicate) {
      out.deduplicated++;
      continue;
    }
    await command(
      ctx,
      {
        audit: {
          action: "idara.schedule.run",
          entityType: "ai_schedule",
          entityId: s.id,
          summary: `${s.kind}: run ${run.id} (${run.credits} credits)`,
        },
      },
      async (tx) => {
        const saved = (await tx.execute(sql`
          insert into public.ai_saved_output (org_id, run_id, message_id, kind, title, content, sources, agent_id, agent_version, created_by)
          values (${ctx.orgId}, ${run.id}, ${answer.id}, ${def.outputKind}, ${`${s.kind} ${now.toISOString().slice(0, 10)}`.slice(0, 200)},
                  ${JSON.stringify({ blocks: answer.blocks, provenance: answer.provenance })}::jsonb, ${JSON.stringify(answer.evidence)}::jsonb,
                  ${s.agentId}, 1, ${ctx.userId})
          returning id::text as id`)) as unknown as Array<{ id: string }>;
        out.notified += await notifyRecipientsIn(tx, ctx, s, saved[0]!.id, now);
        return null;
      },
    );
  }
  return out;
}

async function notifyRecipientsIn(
  tx: TenantTx,
  ctx: Ctx,
  s: ScheduleRow,
  savedOutputId: string,
  now: Date,
): Promise<number> {
  const members = (await tx.execute(sql`
    select m.user_id::text as user_id, rd.archetype
    from public.membership m join public.role_definition rd on rd.org_id = m.org_id and rd.key = m.role_key
    where m.org_id = ${ctx.orgId} and m.deactivated_at is null`)) as unknown as Array<{
    user_id: string;
    archetype: string;
  }>;
  const prefs = (await tx.execute(sql`
    select user_id::text as user_id, muted, snoozed_until::text as snoozed_until, frequency
    from public.ai_schedule_pref where org_id = ${ctx.orgId} and schedule_id = ${s.id}`)) as unknown as Array<{
    user_id: string;
    muted: boolean;
    snoozed_until: string | null;
    frequency: string;
  }>;
  const prefOf = new Map(prefs.map((p) => [p.user_id, p]));
  let n = 0;
  for (const m of members) {
    if (!s.recipients.includes(m.archetype)) continue;
    const p = prefOf.get(m.user_id);
    if (p?.muted) continue;
    if (p?.snoozed_until && new Date(p.snoozed_until) > now) continue;
    if (p?.frequency === "weekly" && s.cadence === "daily" && now.getUTCDay() !== 1) continue;
    await createNotificationIn(tx, ctx, {
      recipientUserId: m.user_id,
      kind: "idara_alert",
      title: `Idara: ${s.kind.replace(/_/g, " ")}`.slice(0, 200),
      body: "A scheduled briefing is ready in Idara. Open it to see the evidence and why it was generated.",
      entityType: "ai_saved_output",
      entityId: savedOutputId,
    });
    n++;
  }
  return n;
}

/** Platform sweep: every organisation with an enabled schedule, under its owner (dedicated client discovery). */
export async function sweepIdaraSchedules(
  requestId: string,
  now: Date = new Date(),
): Promise<{
  orgs: number;
  due: number;
  ran: number;
  deduplicated: number;
  notified: number;
  failed: number;
}> {
  const out = { orgs: 0, due: 0, ran: 0, deduplicated: 0, notified: 0, failed: 0 };
  if (!idaraEnabled()) return out;
  const { db, end } = createAppDb({ max: 1 });
  try {
    const targets = (await db.execute(
      sql`select org_id::text as org_id, actor_user_id::text as actor_user_id from app.orgs_with_ai_schedules()`,
    )) as unknown as Array<{ org_id: string; actor_user_id: string }>;
    out.orgs = targets.length;
    for (const t of targets) {
      const ctx: Ctx = {
        orgId: t.org_id,
        userId: t.actor_user_id,
        costPrivileged: false,
        pricePrivileged: false,
        requestId,
      };
      try {
        const r = await runDueSchedules(ctx, "owner", now);
        out.due += r.due;
        out.ran += r.ran;
        out.deduplicated += r.deduplicated;
        out.notified += r.notified;
      } catch (e) {
        out.failed++;
        logger.warn(
          {
            worker: "idara-schedule-sweep",
            org_id: t.org_id,
            request_id: requestId,
            err: String((e as Error).message ?? e),
          },
          "idara schedule sweep failed for organisation",
        );
      }
    }
  } finally {
    await end();
  }
  return out;
}

export async function listSavedOutputs(
  ctx: Ctx,
  q: { kind?: string; limit: number; offset: number },
): Promise<{
  rows: Array<{
    id: string;
    kind: string;
    title: string;
    agentId: string;
    approvalStatus: string;
    createdAt: string;
    runId: string | null;
  }>;
  total: number;
}> {
  const limit = Math.min(Math.max(q.limit, 1), 100);
  return withCtx(ctx, async (tx) => {
    const where = sql`org_id = ${ctx.orgId} and (${q.kind ?? null}::text is null or kind = ${q.kind ?? null})`;
    const rows = (await tx.execute(sql`
      select id::text as id, kind, title, agent_id, approval_status, created_at::text as created_at, run_id::text as run_id
      from public.ai_saved_output where ${where} order by created_at desc limit ${limit} offset ${Math.max(q.offset, 0)}`)) as unknown as Array<
      Record<string, unknown>
    >;
    const total = (await tx.execute(
      sql`select count(*)::int as n from public.ai_saved_output where ${where}`,
    )) as unknown as Array<{ n: number }>;
    return {
      rows: rows.map((r) => ({
        id: String(r.id),
        kind: String(r.kind),
        title: String(r.title),
        agentId: String(r.agent_id),
        approvalStatus: String(r.approval_status),
        createdAt: String(r.created_at),
        runId: (r.run_id as string | null) ?? null,
      })),
      total: Number(total[0]?.n ?? 0),
    };
  });
}

export async function getSavedOutput(
  ctx: Ctx,
  id: string,
): Promise<{
  id: string;
  kind: string;
  title: string;
  content: unknown;
  sources: unknown;
  agentId: string;
  agentVersion: number;
  approvalStatus: string;
  createdAt: string;
  runId: string | null;
} | null> {
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select id::text as id, kind, title, content, sources, agent_id, agent_version, approval_status, created_at::text as created_at, run_id::text as run_id
      from public.ai_saved_output where id = ${id} and org_id = ${ctx.orgId}`),
  )) as unknown as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    kind: String(r.kind),
    title: String(r.title),
    content: asJson<unknown>(r.content, {}),
    sources: asJson<unknown>(r.sources, []),
    agentId: String(r.agent_id),
    agentVersion: Number(r.agent_version),
    approvalStatus: String(r.approval_status),
    createdAt: String(r.created_at),
    runId: (r.run_id as string | null) ?? null,
  };
}

/** Explicit save of an answer as an output (the person chooses the kind and title). */
export async function saveOutput(ctx: Ctx, raw: unknown): Promise<{ id: string }> {
  const input = z
    .object({
      conversationId: z.string().uuid(),
      messageId: z.string().uuid(),
      kind: z.enum([
        "task_draft",
        "document_draft",
        "report",
        "scenario",
        "analysis",
        "automation_proposal",
        "meeting_brief",
      ]),
      title: z.string().trim().min(1).max(200),
    })
    .parse(raw);
  const conversation = await getConversation(ctx, input.conversationId);
  if (!conversation) throw new Error("conversation not found");
  const msgs = await listMessages(ctx, input.conversationId, { limit: 200 });
  const m = msgs.rows.find((x) => x.id === input.messageId);
  if (!m || m.role !== "assistant") throw new Error("message not found");
  return command(
    ctx,
    {
      audit: {
        action: "idara.output.save",
        entityType: "ai_saved_output",
        entityId: input.messageId,
        summary: `${input.kind}: ${input.title}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.ai_saved_output (org_id, run_id, message_id, kind, title, content, sources, agent_id, agent_version, created_by)
        values (${ctx.orgId}, ${m.runId}, ${m.id}, ${input.kind}, ${input.title}, ${JSON.stringify({ blocks: m.blocks, provenance: m.provenance })}::jsonb,
                ${JSON.stringify(m.evidence)}::jsonb, ${m.provenance.answeredBy ?? m.agentId ?? "idara"}, 1, ${ctx.userId})
        returning id::text as id`)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}
