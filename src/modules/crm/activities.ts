/**
 * H27 — activities and engagement on leads, opportunities, customers and
 * contacts (ADR-35). One table (`sales_activity`, widened in 0120): calls,
 * meetings, emails, messages, tasks, notes, follow-ups, site visits,
 * demonstrations and custom kinds; participants, outcome, next action,
 * reminders, recurrence and templates. Provider adapters for email, calendar
 * and messaging are declared here and FAIL CLOSED without credentials:
 * manual logging and internal reminders work fully without them.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { createNotificationIn } from "@/platform/notifications";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";

export const ACTIVITY_KINDS = [
  "note",
  "call",
  "meeting",
  "email",
  "message",
  "task",
  "follow_up",
  "site_visit",
  "demo",
  "custom",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ACTIVITY_OUTCOMES = [
  "completed",
  "no_answer",
  "rescheduled",
  "positive",
  "neutral",
  "negative",
  "cancelled",
] as const;

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const Participant = z.object({
  kind: z.enum(["member", "contact", "external"]),
  id: uuid.optional(),
  name: z.string().trim().min(1).max(120),
});

export const ActivityTemplates = [
  {
    key: "discovery_call",
    kind: "call",
    title: { en: "Discovery call", ar: "مكالمة استكشاف" },
    followUpDays: 3,
  },
  {
    key: "site_survey",
    kind: "site_visit",
    title: { en: "Site survey", ar: "معاينة الموقع" },
    followUpDays: 2,
  },
  {
    key: "proposal_walkthrough",
    kind: "meeting",
    title: { en: "Proposal walkthrough", ar: "استعراض العرض" },
    followUpDays: 5,
  },
  { key: "demo", kind: "demo", title: { en: "Demonstration", ar: "عرض توضيحي" }, followUpDays: 3 },
  { key: "check_in", kind: "call", title: { en: "Check-in", ar: "متابعة" }, followUpDays: 14 },
  {
    key: "renewal_review",
    kind: "meeting",
    title: { en: "Renewal review", ar: "مراجعة التجديد" },
    followUpDays: 7,
  },
] as const;

export const CrmActivityInput = z.object({
  leadId: uuid.optional().nullable(),
  opportunityId: uuid.optional().nullable(),
  customerId: uuid.optional().nullable(),
  contactId: uuid.optional().nullable(),
  kind: z.enum(ACTIVITY_KINDS),
  customKind: z.string().trim().max(60).optional().nullable(),
  title: z.string().trim().max(200).optional().nullable(),
  body: z.string().trim().max(2000).optional().nullable(),
  dueDate: isoDate.optional().nullable(),
  reminderAt: z.string().datetime().optional().nullable(),
  ownerUserId: uuid.optional().nullable(),
  participants: z.array(Participant).max(20).default([]),
  outcome: z.enum(ACTIVITY_OUTCOMES).optional().nullable(),
  nextAction: z.string().trim().max(300).optional().nullable(),
  nextActionDue: isoDate.optional().nullable(),
  location: z.string().trim().max(200).optional().nullable(),
  recurrenceDays: z.number().int().min(1).max(365).optional().nullable(),
  templateKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .optional()
    .nullable(),
  completed: z.boolean().default(false),
});
export type CrmActivityInput = z.infer<typeof CrmActivityInput>;

export type ActivityRow = {
  id: string;
  leadId: string | null;
  opportunityId: string | null;
  customerId: string | null;
  contactId: string | null;
  kind: string;
  customKind: string | null;
  title: string | null;
  body: string | null;
  dueDate: string | null;
  reminderAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  actorUserId: string | null;
  actorName: string | null;
  participants: Array<z.infer<typeof Participant>>;
  outcome: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  location: string | null;
  recurrenceDays: number | null;
  templateKey: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
};

export class ActivityError extends Error {
  readonly code: "not_found" | "validation" | "state";
  constructor(message: string, code: ActivityError["code"]) {
    super(message);
    this.code = code;
  }
}

const SELECT = sql`
  select a.id::text as id, a.lead_id::text as lead_id, a.opportunity_id::text as opportunity_id,
         a.customer_id::text as customer_id, a.contact_id::text as contact_id, a.kind, a.custom_kind, a.title, a.body,
         a.due_date::text as due_date, a.reminder_at::text as reminder_at, a.completed_at::text as completed_at,
         a.completed_by::text as completed_by, a.owner_user_id::text as owner_user_id, o.full_name as owner_name,
         a.actor_user_id::text as actor_user_id, u.full_name as actor_name, a.participants, a.outcome,
         a.next_action, a.next_action_due::text as next_action_due, a.location, a.recurrence_days, a.template_key,
         a.meta, a.created_at::text as created_at
  from public.sales_activity a
  left join public.user_profile o on o.id = a.owner_user_id
  left join public.user_profile u on u.id = a.actor_user_id
`;

function rowToActivity(r: Record<string, unknown>): ActivityRow {
  return {
    id: String(r.id),
    leadId: (r.lead_id as string | null) ?? null,
    opportunityId: (r.opportunity_id as string | null) ?? null,
    customerId: (r.customer_id as string | null) ?? null,
    contactId: (r.contact_id as string | null) ?? null,
    kind: String(r.kind),
    customKind: (r.custom_kind as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    body: (r.body as string | null) ?? null,
    dueDate: (r.due_date as string | null) ?? null,
    reminderAt: (r.reminder_at as string | null) ?? null,
    completedAt: (r.completed_at as string | null) ?? null,
    completedBy: (r.completed_by as string | null) ?? null,
    ownerUserId: (r.owner_user_id as string | null) ?? null,
    ownerName: (r.owner_name as string | null) ?? null,
    actorUserId: (r.actor_user_id as string | null) ?? null,
    actorName: (r.actor_name as string | null) ?? null,
    participants: (Array.isArray(r.participants)
      ? r.participants
      : []) as ActivityRow["participants"],
    outcome: (r.outcome as string | null) ?? null,
    nextAction: (r.next_action as string | null) ?? null,
    nextActionDue: (r.next_action_due as string | null) ?? null,
    location: (r.location as string | null) ?? null,
    recurrenceDays: r.recurrence_days === null ? null : Number(r.recurrence_days),
    templateKey: (r.template_key as string | null) ?? null,
    meta: (r.meta as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at),
  };
}

async function assertSubjectsIn(tx: TenantTx, ctx: Ctx, input: CrmActivityInput): Promise<void> {
  if (!input.leadId && !input.opportunityId && !input.customerId)
    throw new ActivityError("an activity needs a lead, an opportunity or a customer", "validation");
  const checks: Array<[string | null | undefined, string]> = [
    [input.leadId, "lead"],
    [input.opportunityId, "opportunity"],
    [input.customerId, "customer"],
    [input.contactId, "customer_contact"],
  ];
  for (const [id, table] of checks) {
    if (!id) continue;
    const rows = (await tx.execute(
      table === "lead"
        ? sql`select 1 from public.lead where id = ${id} and org_id = ${ctx.orgId}`
        : table === "opportunity"
          ? sql`select 1 from public.opportunity where id = ${id} and org_id = ${ctx.orgId}`
          : table === "customer"
            ? sql`select 1 from public.customer where id = ${id} and org_id = ${ctx.orgId}`
            : sql`select 1 from public.customer_contact where id = ${id} and org_id = ${ctx.orgId}`,
    )) as unknown as unknown[];
    if (!rows.length) throw new ActivityError(`${table} not found`, "not_found");
  }
}

export async function logActivity(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<ActivityRow> {
  const input = CrmActivityInput.parse(raw);
  assertCan(
    archetype,
    input.leadId
      ? "leads.manage"
      : input.opportunityId
        ? "opportunities.manage"
        : "customers.manage",
  );
  if (input.kind === "custom" && !input.customKind)
    throw new ActivityError("custom kind needs a name", "validation");
  if ((input.kind === "follow_up" || input.kind === "task") && !input.dueDate)
    throw new ActivityError("a follow-up or task needs a due date", "validation");
  const template = input.templateKey
    ? ActivityTemplates.find((t) => t.key === input.templateKey)
    : undefined;
  return command(
    ctx,
    {
      audit: (r: ActivityRow) => ({
        action: "crm.activity.log",
        entityType: input.opportunityId ? "opportunity" : input.leadId ? "lead" : "customer",
        entityId: input.opportunityId ?? input.leadId ?? input.customerId ?? undefined,
        summary: `${input.kind}${input.title ? `: ${input.title}` : ""} (${r.id.slice(0, 8)})`,
      }),
    },
    async (tx) => {
      await assertSubjectsIn(tx, ctx, input);
      const rows = (await tx.execute(sql`
        insert into public.sales_activity
          (org_id, lead_id, opportunity_id, customer_id, contact_id, kind, custom_kind, title, body, due_date, reminder_at,
           owner_user_id, actor_user_id, participants, outcome, next_action, next_action_due, location, recurrence_days,
           template_key, completed_at, completed_by)
        values (${ctx.orgId}, ${input.leadId ?? null}, ${input.opportunityId ?? null}, ${input.customerId ?? null}, ${input.contactId ?? null},
                ${input.kind}, ${input.customKind ?? null}, ${input.title ?? (template ? template.title.en : null)}, ${input.body ?? null},
                ${input.dueDate ?? null}::date, ${input.reminderAt ?? null}::timestamptz,
                ${input.ownerUserId ?? ctx.userId}, ${ctx.userId}, ${JSON.stringify(input.participants)}::jsonb,
                ${input.outcome ?? null}, ${input.nextAction ?? null}, ${input.nextActionDue ?? null}::date, ${input.location ?? null},
                ${input.recurrenceDays ?? null}, ${input.templateKey ?? null},
                ${input.completed ? sql`now()` : null}, ${input.completed ? ctx.userId : null})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const id = rows[0]!.id;
      if (input.opportunityId)
        await tx.execute(sql`
          update public.opportunity set last_activity_at = now(),
            next_action = coalesce(${input.nextAction ?? null}, next_action),
            next_action_due = coalesce(${input.nextActionDue ?? null}::date, next_action_due)
          where id = ${input.opportunityId} and org_id = ${ctx.orgId}
        `);
      // A completed template activity schedules its follow-up automatically (internal reminder).
      if (
        input.completed &&
        template?.followUpDays &&
        (input.nextAction || template.followUpDays > 0)
      ) {
        await tx.execute(sql`
          insert into public.sales_activity
            (org_id, lead_id, opportunity_id, customer_id, contact_id, kind, title, due_date, owner_user_id, actor_user_id, meta)
          values (${ctx.orgId}, ${input.leadId ?? null}, ${input.opportunityId ?? null}, ${input.customerId ?? null}, ${input.contactId ?? null},
                  'follow_up', ${input.nextAction ?? `Follow up: ${template.title.en}`}, (current_date + (${template.followUpDays})::int),
                  ${input.ownerUserId ?? ctx.userId}, ${ctx.userId}, ${JSON.stringify({ spawnedBy: id, templateKey: template.key })}::jsonb)
        `);
      }
      if (
        input.ownerUserId &&
        input.ownerUserId !== ctx.userId &&
        (input.kind === "task" || input.kind === "follow_up")
      )
        await createNotificationIn(tx, ctx, {
          recipientUserId: input.ownerUserId,
          kind: "crm_follow_up_due",
          title: input.title ?? `${input.kind} (${input.dueDate})`,
          entityType: input.opportunityId ? "opportunity" : input.leadId ? "lead" : "customer",
          entityId: input.opportunityId ?? input.leadId ?? input.customerId ?? undefined,
        });
      const out = (await tx.execute(
        sql`${SELECT} where a.id = ${id} and a.org_id = ${ctx.orgId}`,
      )) as unknown as Array<Record<string, unknown>>;
      return rowToActivity(out[0]!);
    },
  );
}

export const CompleteActivityInput = z.object({
  id: uuid,
  outcome: z.enum(ACTIVITY_OUTCOMES).optional().nullable(),
  note: z.string().trim().max(2000).optional().nullable(),
  nextAction: z.string().trim().max(300).optional().nullable(),
  nextActionDue: isoDate.optional().nullable(),
});

/** Complete a task/follow-up/meeting with an outcome; a recurring one spawns the next occurrence. */
export async function completeActivity(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; nextId: string | null }> {
  const input = CompleteActivityInput.parse(raw);
  return command(
    ctx,
    {
      audit: {
        action: "crm.activity.complete",
        entityType: "customer",

        summary: `${input.id.slice(0, 8)}${input.outcome ? ` (${input.outcome})` : ""}`,
      },
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        select ${SELECT.queryChunks ? sql`` : sql``}a.* from public.sales_activity a where a.id = ${input.id} and a.org_id = ${ctx.orgId} for update
      `)) as unknown as Array<Record<string, unknown>>;
      const a = rows[0];
      if (!a) throw new ActivityError("activity not found", "not_found");
      assertCan(
        archetype,
        a.lead_id ? "leads.manage" : a.opportunity_id ? "opportunities.manage" : "customers.manage",
      );
      if (a.completed_at) throw new ActivityError("already completed", "state");
      await tx.execute(sql`
        update public.sales_activity set completed_at = now(), completed_by = ${ctx.userId},
          outcome = coalesce(${input.outcome ?? null}, outcome),
          body = case when ${input.note ?? null}::text is null then body else concat_ws(E'\n', body, ${input.note ?? null}::text) end,
          next_action = coalesce(${input.nextAction ?? null}, next_action),
          next_action_due = coalesce(${input.nextActionDue ?? null}::date, next_action_due)
        where id = ${input.id} and org_id = ${ctx.orgId}
      `);
      let nextId: string | null = null;
      const rec = a.recurrence_days === null ? null : Number(a.recurrence_days);
      if (rec && (a.kind === "follow_up" || a.kind === "task")) {
        const n = (await tx.execute(sql`
          insert into public.sales_activity
            (org_id, lead_id, opportunity_id, customer_id, contact_id, kind, title, body, due_date, owner_user_id, actor_user_id, recurrence_days, meta)
          values (${ctx.orgId}, ${a.lead_id as string | null}, ${a.opportunity_id as string | null}, ${a.customer_id as string | null}, ${a.contact_id as string | null},
                  ${a.kind as string}, ${a.title as string | null}, ${a.body as string | null},
                  (coalesce(${a.due_date as string | null}::date, current_date) + (${rec})::int),
                  ${a.owner_user_id as string | null}, ${ctx.userId}, ${rec}, ${JSON.stringify({ spawnedBy: input.id, recurring: true })}::jsonb)
          returning id::text as id
        `)) as unknown as Array<{ id: string }>;
        nextId = n[0]!.id;
      }
      if (a.opportunity_id)
        await tx.execute(sql`
          update public.opportunity set last_activity_at = now(),
            next_action = coalesce(${input.nextAction ?? null}, next_action),
            next_action_due = coalesce(${input.nextActionDue ?? null}::date, next_action_due)
          where id = ${a.opportunity_id as string} and org_id = ${ctx.orgId}
        `);
      return { id: input.id, nextId };
    },
  );
}

export type ActivityFilter = {
  leadId?: string;
  opportunityId?: string;
  customerId?: string;
  contactId?: string;
  ownerUserId?: string;
  openOnly?: boolean;
  from?: string;
  to?: string;
  kinds?: string[];
  limit?: number;
  offset?: number;
};

export async function listActivities(
  ctx: Ctx,
  archetype: RoleArchetype,
  f: ActivityFilter = {},
): Promise<{ rows: ActivityRow[]; total: number }> {
  assertCan(archetype, "customers.view");
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const offset = Math.max(f.offset ?? 0, 0);
  const kinds = f.kinds?.length ? JSON.stringify(f.kinds) : null;
  const where = sql`
    a.org_id = ${ctx.orgId}
    and (${f.leadId ?? null}::uuid is null or a.lead_id = ${f.leadId ?? null}::uuid)
    and (${f.opportunityId ?? null}::uuid is null or a.opportunity_id = ${f.opportunityId ?? null}::uuid)
    and (${f.customerId ?? null}::uuid is null or a.customer_id = ${f.customerId ?? null}::uuid
         or a.opportunity_id in (select id from public.opportunity where org_id = ${ctx.orgId} and customer_id = ${f.customerId ?? null}::uuid))
    and (${f.contactId ?? null}::uuid is null or a.contact_id = ${f.contactId ?? null}::uuid)
    and (${f.ownerUserId ?? null}::uuid is null or a.owner_user_id = ${f.ownerUserId ?? null}::uuid)
    and (${f.openOnly !== true} or (a.completed_at is null and a.kind in ('follow_up', 'task', 'meeting', 'call', 'site_visit', 'demo')))
    and (${f.from ?? null}::date is null or coalesce(a.due_date, a.created_at::date) >= ${f.from ?? null}::date)
    and (${f.to ?? null}::date is null or coalesce(a.due_date, a.created_at::date) <= ${f.to ?? null}::date)
    and (${kinds}::jsonb is null or a.kind in (select x from jsonb_array_elements_text(${kinds}::jsonb) as x))
  `;
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      ${SELECT} where ${where}
      order by coalesce(a.due_date, a.created_at::date) desc, a.created_at desc
      limit ${limit} offset ${offset}
    `)) as unknown as Array<Record<string, unknown>>;
    const cnt = (await tx.execute(
      sql`select count(*)::int as n from public.sales_activity a where ${where}`,
    )) as unknown as Array<{ n: number }>;
    return { rows: rows.map(rowToActivity), total: Number(cnt[0]?.n ?? 0) };
  });
}

/** The person's commercial queue: open tasks and follow-ups, overdue first. */
export async function myCommercialQueue(
  ctx: Ctx,
  archetype: RoleArchetype,
  asOf: string,
): Promise<{ overdue: ActivityRow[]; today: ActivityRow[]; upcoming: ActivityRow[] }> {
  assertCan(archetype, "customers.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      ${SELECT}
      where a.org_id = ${ctx.orgId} and a.owner_user_id = ${ctx.userId} and a.completed_at is null
        and a.kind in ('follow_up', 'task', 'meeting', 'call', 'site_visit', 'demo')
      order by a.due_date asc nulls last, a.created_at asc
      limit 200
    `),
  )) as unknown as Array<Record<string, unknown>>;
  const all = rows.map(rowToActivity);
  return {
    overdue: all.filter((a) => a.dueDate !== null && a.dueDate < asOf),
    today: all.filter((a) => a.dueDate === asOf),
    upcoming: all.filter((a) => a.dueDate === null || a.dueDate > asOf),
  };
}

// ── provider adapters (declared; fail closed without credentials) ─────────────
export type ChannelProvider = {
  channel: "email" | "calendar" | "messaging";
  name: string;
  configured: boolean;
  ownerAction: string | null;
};

export function channelProviders(): ChannelProvider[] {
  return [
    {
      channel: "email",
      name: "resend",
      configured: Boolean(process.env.RESEND_API_KEY),
      ownerAction: process.env.RESEND_API_KEY
        ? null
        : "Set RESEND_API_KEY in the platform secret store to send email from IdaraWorks (OA-4).",
    },
    {
      channel: "calendar",
      name: "none",
      configured: false,
      ownerAction:
        "Connect a calendar provider (Google Workspace or Microsoft 365 OAuth) in a later provisioning step; meetings are logged and reminded internally meanwhile.",
    },
    {
      channel: "messaging",
      name: "none",
      configured: false,
      ownerAction:
        "Contract a WhatsApp Business or SMS provider and set its credentials; messages are logged manually meanwhile.",
    },
  ];
}
