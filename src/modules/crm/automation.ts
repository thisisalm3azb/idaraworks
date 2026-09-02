/**
 * H27 — governed CRM automation (ADR-43). An automation has an owner, one
 * trigger, conditions (the platform rules evaluator over the subject's
 * facts), a closed list of actions, an enabled flag and a dry-run mode. Every
 * evaluation writes an immutable run row keyed by (automation, subject,
 * occurrence) so a re-run is a no-op; a dry run records what WOULD happen.
 * Actions never sign, send campaigns, post accounting or move a stage
 * without review: the strongest action is to create a task, notify, request
 * an approval, flag a risk or set a forecast category (recorded as a
 * forecast change like any human edit).
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import { createNotificationIn } from "@/platform/notifications";
import type { RoleArchetype } from "@/platform/registries";
import { evaluateConditions, type Condition } from "@/platform/rules/conditions";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";

const uuid = z.string().uuid();
export const AUTOMATION_TRIGGERS = [
  "lead_created",
  "lead_unassigned",
  "lead_stale",
  "opportunity_stage_aged",
  "opportunity_stalled",
  "opportunity_close_date_passed",
  "opportunity_stage_entered",
  "renewal_due",
  "customer_at_risk",
  "follow_up_overdue",
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({
      key: z.string().min(1).max(80),
      op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "in", "empty", "not_empty", "truthy"]),
      value: z
        .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
        .optional(),
    }),
    z.object({ all: z.array(ConditionSchema).max(20) }),
    z.object({ any: z.array(ConditionSchema).max(20) }),
    z.object({ not: ConditionSchema }),
  ]),
);

export const ActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assign_owner"), userId: uuid }),
  z.object({
    kind: z.literal("create_task"),
    title: z.string().min(1).max(200),
    dueInDays: z.number().int().min(0).max(365).default(1),
    assignToOwner: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("notify"),
    userId: uuid.optional(),
    toOwner: z.boolean().default(true),
    title: z.string().min(1).max(200),
  }),
  z.object({ kind: z.literal("request_approval"), note: z.string().max(500).optional() }),
  z.object({
    kind: z.literal("flag_risk"),
    title: z.string().min(1).max(200),
    severity: z.enum(["low", "medium", "high"]).default("medium"),
  }),
  z.object({
    kind: z.literal("set_forecast_category"),
    category: z.enum(["pipeline", "best_case", "commit", "omitted"]),
  }),
]);
export type AutomationAction = z.infer<typeof ActionSchema>;

export const AutomationInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional().nullable(),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  conditions: ConditionSchema.default({ all: [] }),
  actions: z.array(ActionSchema).min(1).max(5),
  enabled: z.boolean().default(false),
  dryRun: z.boolean().default(true),
  ownerUserId: uuid.optional().nullable(),
});

export type AutomationRow = {
  id: string;
  name: string;
  description: string | null;
  trigger: AutomationTrigger;
  conditions: Condition;
  actions: AutomationAction[];
  enabled: boolean;
  dryRun: boolean;
  ownerUserId: string;
  ownerName: string | null;
  lastRunAt: string | null;
  runs: number;
  createdAt: string;
};

function rowToAutomation(r: Record<string, unknown>): AutomationRow {
  return {
    id: String(r.id),
    name: String(r.name),
    description: (r.description as string | null) ?? null,
    trigger: String(r.trigger) as AutomationTrigger,
    conditions: (r.conditions as Condition) ?? { all: [] },
    actions: (Array.isArray(r.actions) ? r.actions : []) as AutomationAction[],
    enabled: Boolean(r.enabled),
    dryRun: Boolean(r.dry_run),
    ownerUserId: String(r.owner_user_id),
    ownerName: (r.owner_name as string | null) ?? null,
    lastRunAt: (r.last_run_at as string | null) ?? null,
    runs: Number(r.runs ?? 0),
    createdAt: String(r.created_at),
  };
}

const SELECT = sql`
  select a.id::text as id, a.name, a.description, a.trigger, a.conditions, a.actions, a.enabled, a.dry_run,
         a.owner_user_id::text as owner_user_id, u.full_name as owner_name, a.last_run_at::text as last_run_at,
         (select count(*)::int from public.crm_automation_run r where r.org_id = a.org_id and r.automation_id = a.id) as runs,
         a.created_at::text as created_at
  from public.crm_automation a left join public.user_profile u on u.id = a.owner_user_id
`;

export async function createAutomation(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<AutomationRow> {
  assertCan(archetype, "crm.automations.manage");
  const input = AutomationInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: AutomationRow) => ({
        action: "crm.automation.create",
        entityType: "crm_automation",
        entityId: r.id,
        summary: `${input.name} on ${input.trigger}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.crm_automation (org_id, name, description, trigger, conditions, actions, enabled, dry_run, owner_user_id, created_by)
        values (${ctx.orgId}, ${input.name}, ${input.description ?? null}, ${input.trigger}, ${JSON.stringify(input.conditions)}::jsonb,
                ${JSON.stringify(input.actions)}::jsonb, ${input.enabled}, ${input.dryRun}, ${input.ownerUserId ?? ctx.userId}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const out = (await tx.execute(
        sql`${SELECT} where a.id = ${rows[0]!.id} and a.org_id = ${ctx.orgId}`,
      )) as unknown as Array<Record<string, unknown>>;
      return rowToAutomation(out[0]!);
    },
  );
}

/**
 * Explicit patch schema: a partial update must never re-apply the input
 * defaults (a patch that only flips `enabled` would otherwise reset the
 * conditions to "match everything").
 */
export const AutomationPatch = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional().nullable(),
  trigger: z.enum(AUTOMATION_TRIGGERS).optional(),
  conditions: ConditionSchema.optional(),
  actions: z.array(ActionSchema).min(1).max(5).optional(),
  enabled: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  ownerUserId: uuid.optional().nullable(),
});

export async function updateAutomation(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "crm.automations.manage");
  const input = AutomationPatch.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "crm.automation.update",
        entityType: "crm_automation",
        entityId: input.id,
        summary: input.enabled === undefined ? "updated" : input.enabled ? "enabled" : "disabled",
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.crm_automation set
          name = coalesce(${input.name ?? null}, name),
          description = case when ${input.description === undefined} then description else ${input.description ?? null} end,
          trigger = coalesce(${input.trigger ?? null}, trigger),
          conditions = coalesce(${input.conditions ? JSON.stringify(input.conditions) : null}::jsonb, conditions),
          actions = coalesce(${input.actions ? JSON.stringify(input.actions) : null}::jsonb, actions),
          enabled = coalesce(${input.enabled ?? null}, enabled),
          dry_run = coalesce(${input.dryRun ?? null}, dry_run),
          owner_user_id = coalesce(${input.ownerUserId ?? null}::uuid, owner_user_id)
        where id = ${input.id} and org_id = ${ctx.orgId}
      `);
    },
  );
}

export async function listAutomations(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<AutomationRow[]> {
  assertCan(archetype, "crm.automations.manage");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`${SELECT} where a.org_id = ${ctx.orgId} order by a.created_at desc limit 200`),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map(rowToAutomation);
}

export type RunRow = {
  id: string;
  automationId: string;
  subjectType: string;
  subjectId: string;
  occurrenceKey: string;
  mode: string;
  status: string;
  result: unknown[];
  error: string | null;
  ranAt: string;
  ranBy: string | null;
};

export async function listRuns(
  ctx: Ctx,
  archetype: RoleArchetype,
  automationId: string,
  limit = 100,
): Promise<RunRow[]> {
  assertCan(archetype, "crm.automations.manage");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select r.id::text as id, r.automation_id::text as automation_id, r.subject_type, r.subject_id::text as subject_id, r.occurrence_key, r.mode, r.status, r.result, r.error,
             r.ran_at::text as ran_at, u.full_name as ran_by
      from public.crm_automation_run r left join public.user_profile u on u.id = r.ran_by
      where r.org_id = ${ctx.orgId} and r.automation_id = ${automationId} order by r.ran_at desc limit ${Math.min(Math.max(limit, 1), 500)}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    automationId: String(r.automation_id),
    subjectType: String(r.subject_type),
    subjectId: String(r.subject_id),
    occurrenceKey: String(r.occurrence_key),
    mode: String(r.mode),
    status: String(r.status),
    result: (Array.isArray(r.result) ? r.result : []) as unknown[],
    error: (r.error as string | null) ?? null,
    ranAt: String(r.ran_at),
    ranBy: (r.ran_by as string | null) ?? null,
  }));
}

// ── subjects and facts per trigger ───────────────────────────────────────────
type Subject = {
  type: "lead" | "opportunity" | "customer" | "activity" | "obligation";
  id: string;
  ownerUserId: string | null;
  facts: Record<string, string | number | boolean | null>;
  occurrence: string;
};

async function subjectsForIn(
  tx: TenantTx,
  ctx: Ctx,
  trigger: AutomationTrigger,
  today: string,
): Promise<Subject[]> {
  const day = today; // occurrence keys are day-scoped for time triggers
  switch (trigger) {
    case "lead_created":
    case "lead_unassigned":
    case "lead_stale": {
      const rows = (await tx.execute(sql`
        select id::text as id, owner_user_id::text as owner, status, source_kind, quarantine, estimated_value_minor,
               greatest(0, extract(day from now() - created_at))::int as age_days,
               greatest(0, extract(day from now() - updated_at))::int as idle_days
        from public.lead where org_id = ${ctx.orgId} and archived = false and status in ('new', 'contacted', 'qualified')
          and (${trigger} <> 'lead_unassigned' or owner_user_id is null)
          and (${trigger} <> 'lead_created' or created_at >= now() - interval '1 day')
        limit 2000
      `)) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        type: "lead",
        id: String(r.id),
        ownerUserId: (r.owner as string | null) ?? null,
        facts: {
          status: String(r.status),
          source_kind: String(r.source_kind),
          quarantine: String(r.quarantine),
          value_minor: r.estimated_value_minor === null ? null : Number(r.estimated_value_minor),
          age_days: Number(r.age_days),
          idle_days: Number(r.idle_days),
          unassigned: r.owner === null,
        },
        occurrence: trigger === "lead_created" ? "created" : day,
      }));
    }
    case "opportunity_stage_aged":
    case "opportunity_stalled":
    case "opportunity_close_date_passed":
    case "opportunity_stage_entered": {
      const rows = (await tx.execute(sql`
        select o.id::text as id, o.owner_user_id::text as owner, o.stage_key, o.forecast_category, o.kind, o.estimated_value_minor, o.probability,
               greatest(0, extract(day from now() - o.stage_entered_at))::int as stage_age_days,
               case when o.last_activity_at is null then null else greatest(0, extract(day from now() - o.last_activity_at))::int end as inactive_days,
               (o.expected_close_date < ${day}::date) as close_passed, s.max_age_days,
               (o.stage_entered_at >= now() - interval '1 day') as entered_today, o.stage_entered_at::text as entered
        from public.opportunity o left join public.pipeline_stage s on s.org_id = o.org_id and s.key = o.stage_key
          and s.pipeline_id = coalesce(o.pipeline_id, (select p.id from public.crm_pipeline p where p.org_id = o.org_id and p.is_default limit 1))
        where o.org_id = ${ctx.orgId} and o.status = 'open' and o.archived = false
          and (${trigger} <> 'opportunity_stage_entered' or o.stage_entered_at >= now() - interval '1 day')
        limit 5000
      `)) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        type: "opportunity",
        id: String(r.id),
        ownerUserId: (r.owner as string | null) ?? null,
        facts: {
          stage_key: String(r.stage_key),
          forecast_category: String(r.forecast_category),
          kind: String(r.kind),
          value_minor: r.estimated_value_minor === null ? null : Number(r.estimated_value_minor),
          probability: r.probability === null ? null : Number(r.probability),
          stage_age_days: Number(r.stage_age_days),
          inactive_days: r.inactive_days === null ? null : Number(r.inactive_days),
          close_passed: Boolean(r.close_passed),
          over_max_age:
            r.max_age_days !== null && Number(r.stage_age_days) > Number(r.max_age_days),
        },
        occurrence:
          trigger === "opportunity_stage_entered"
            ? `${String(r.stage_key)}@${String(r.entered).slice(0, 19)}`
            : `${String(r.stage_key)}:${day}`,
      }));
    }
    case "renewal_due": {
      const rows = (await tx.execute(sql`
        select o.id::text as id, o.owner_user_id::text as owner, (o.due_on - current_date)::int as days_left, d.counterparty_id::text as customer_id
        from public.doc_obligation o join public.doc_document d on d.id = o.document_id and d.org_id = o.org_id
        where o.org_id = ${ctx.orgId} and o.kind = 'renewal' and o.status = 'open' limit 2000
      `)) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        type: "obligation",
        id: String(r.id),
        ownerUserId: (r.owner as string | null) ?? null,
        facts: {
          days_left: Number(r.days_left),
          customer_id: (r.customer_id as string | null) ?? null,
        },
        occurrence: day,
      }));
    }
    case "customer_at_risk": {
      const rows = (await tx.execute(sql`
        select c.id::text as id, c.owner_user_id::text as owner,
               (select count(*)::int from public.invoice i where i.org_id = c.org_id and i.customer_id = c.id and i.status in ('issued','partially_paid') and i.due_date < current_date) as overdue_invoices,
               (select count(*)::int from public.crm_customer_signal s where s.org_id = c.org_id and s.customer_id = c.id and s.kind = 'churn_risk' and s.score >= 60) as churn_flags,
               (select max(a.created_at) from public.sales_activity a where a.org_id = c.org_id and a.customer_id = c.id) as last_activity
        from public.customer c where c.org_id = ${ctx.orgId} and c.active and c.merged_into_customer_id is null limit 5000
      `)) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        type: "customer",
        id: String(r.id),
        ownerUserId: (r.owner as string | null) ?? null,
        facts: {
          overdue_invoices: Number(r.overdue_invoices),
          churn_flags: Number(r.churn_flags),
          idle_days: r.last_activity
            ? Math.floor((Date.now() - new Date(String(r.last_activity)).getTime()) / 86_400_000)
            : null,
        },
        occurrence: day,
      }));
    }
    case "follow_up_overdue": {
      const rows = (await tx.execute(sql`
        select id::text as id, owner_user_id::text as owner, (current_date - due_date)::int as overdue_days, kind, opportunity_id::text as opportunity_id, lead_id::text as lead_id, customer_id::text as customer_id
        from public.sales_activity where org_id = ${ctx.orgId} and completed_at is null and kind in ('follow_up', 'task') and due_date < current_date limit 5000
      `)) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        type: "activity",
        id: String(r.id),
        ownerUserId: (r.owner as string | null) ?? null,
        facts: { overdue_days: Number(r.overdue_days), kind: String(r.kind) },
        occurrence: day,
      }));
    }
  }
}

async function performActionIn(
  tx: TenantTx,
  ctx: Ctx,
  a: AutomationRow,
  s: Subject,
  action: AutomationAction,
): Promise<Record<string, unknown>> {
  const link =
    s.type === "opportunity"
      ? { entityType: "opportunity" as const, entityId: s.id }
      : s.type === "lead"
        ? { entityType: "lead" as const, entityId: s.id }
        : s.type === "customer"
          ? { entityType: "customer" as const, entityId: s.id }
          : null;
  switch (action.kind) {
    case "assign_owner": {
      if (s.type === "lead")
        await tx.execute(
          sql`update public.lead set owner_user_id = ${action.userId}, row_version = row_version + 1, updated_at = now() where id = ${s.id} and org_id = ${ctx.orgId} and owner_user_id is null`,
        );
      else if (s.type === "opportunity")
        await tx.execute(
          sql`update public.opportunity set owner_user_id = ${action.userId}, updated_at = now() where id = ${s.id} and org_id = ${ctx.orgId} and owner_user_id is null`,
        );
      else if (s.type === "customer")
        await tx.execute(
          sql`update public.customer set owner_user_id = ${action.userId}, updated_at = now() where id = ${s.id} and org_id = ${ctx.orgId} and owner_user_id is null`,
        );
      await createNotificationIn(tx, ctx, {
        recipientUserId: action.userId,
        kind: "crm_lead_assigned",
        title: `${a.name}: assigned to you`,
        ...(link ?? {}),
      });
      return { kind: action.kind, userId: action.userId };
    }
    case "create_task": {
      const owner = action.assignToOwner ? (s.ownerUserId ?? a.ownerUserId) : a.ownerUserId;
      await tx.execute(sql`
        insert into public.sales_activity (org_id, lead_id, opportunity_id, customer_id, kind, title, due_date, owner_user_id, actor_user_id, meta)
        values (${ctx.orgId}, ${s.type === "lead" ? s.id : null}, ${s.type === "opportunity" ? s.id : null}, ${s.type === "customer" ? s.id : ((s.facts.customer_id as string | null) ?? null)},
                'task', ${action.title}, (current_date + (${action.dueInDays})::int), ${owner}, ${ctx.userId}, ${JSON.stringify({ automationId: a.id, trigger: a.trigger })}::jsonb)
      `);
      return { kind: action.kind, owner };
    }
    case "notify": {
      const to = action.userId ?? (action.toOwner ? s.ownerUserId : null) ?? a.ownerUserId;
      await createNotificationIn(tx, ctx, {
        recipientUserId: to,
        kind:
          s.type === "customer"
            ? "crm_customer_at_risk"
            : s.type === "obligation"
              ? "crm_renewal_due"
              : "crm_opportunity_stalled",
        title: action.title,
        ...(link ?? {}),
      });
      return { kind: action.kind, to };
    }
    case "request_approval": {
      // Approval requests are reviewed by a person; here we notify the owner to raise it, never auto-submit money decisions.
      await createNotificationIn(tx, ctx, {
        recipientUserId: s.ownerUserId ?? a.ownerUserId,
        kind: "crm_discount_requested",
        title: `${a.name}: review needed${action.note ? ` — ${action.note}` : ""}`,
        ...(link ?? {}),
      });
      return { kind: action.kind };
    }
    case "flag_risk": {
      if (s.type !== "opportunity") return { kind: action.kind, skipped: "not an opportunity" };
      await tx.execute(sql`
        insert into public.crm_opportunity_risk (org_id, opportunity_id, kind, title, severity, created_by)
        values (${ctx.orgId}, ${s.id}, 'risk', ${action.title}, ${action.severity}, ${ctx.userId})
      `);
      return { kind: action.kind };
    }
    case "set_forecast_category": {
      if (s.type !== "opportunity") return { kind: action.kind, skipped: "not an opportunity" };
      const prev = (await tx.execute(
        sql`select forecast_category from public.opportunity where id = ${s.id} and org_id = ${ctx.orgId}`,
      )) as unknown as Array<{ forecast_category: string }>;
      if (prev[0] && prev[0].forecast_category !== action.category) {
        await tx.execute(
          sql`update public.opportunity set forecast_category = ${action.category}, row_version = row_version + 1, updated_at = now() where id = ${s.id} and org_id = ${ctx.orgId}`,
        );
        await tx.execute(sql`
          insert into public.sales_activity (org_id, opportunity_id, kind, title, actor_user_id, meta)
          values (${ctx.orgId}, ${s.id}, 'forecast', ${`${prev[0].forecast_category}|${action.category}`}, ${ctx.userId}, ${JSON.stringify({ from: prev[0].forecast_category, to: action.category, automationId: a.id })}::jsonb)
        `);
      }
      return { kind: action.kind, category: action.category };
    }
  }
}

export type RunSummary = {
  automationId: string;
  matched: number;
  applied: number;
  skipped: number;
  failed: number;
  mode: "dry_run" | "live";
};

/**
 * Evaluate one automation now (a person's "run" or "preview", or the worker).
 * Idempotent per subject × occurrence: a second evaluation of the same
 * occurrence is skipped, not repeated.
 */
export async function runAutomation(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<RunSummary> {
  assertCan(archetype, "crm.automations.manage");
  const input = z
    .object({
      id: uuid,
      mode: z.enum(["dry_run", "live"]).optional(),
      asOf: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .parse(raw);
  const today = input.asOf ?? new Date().toISOString().slice(0, 10);
  return command(
    ctx,
    {
      audit: (r: RunSummary) => ({
        action: "crm.automation.run",
        entityType: "crm_automation",
        entityId: input.id,
        summary: `${r.mode}: ${r.matched} matched, ${r.applied} applied, ${r.skipped} skipped, ${r.failed} failed`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(
        sql`${SELECT} where a.id = ${input.id} and a.org_id = ${ctx.orgId}`,
      )) as unknown as Array<Record<string, unknown>>;
      if (!rows[0]) throw new Error("automation not found");
      const a = rowToAutomation(rows[0]);
      const mode: "dry_run" | "live" = input.mode ?? (a.dryRun || !a.enabled ? "dry_run" : "live");
      if (mode === "live" && !a.enabled) throw new Error("enable the automation before a live run");
      const subjects = await subjectsForIn(tx, ctx, a.trigger, today);
      const summary: RunSummary = {
        automationId: a.id,
        matched: 0,
        applied: 0,
        skipped: 0,
        failed: 0,
        mode,
      };
      for (const s of subjects) {
        const ok = evaluateConditions(a.conditions, { bindings: {}, variables: s.facts });
        if (!ok) continue;
        summary.matched++;
        const claimed = (await tx.execute(sql`
          insert into public.crm_automation_run (org_id, automation_id, subject_type, subject_id, occurrence_key, mode, status, ran_by)
          values (${ctx.orgId}, ${a.id}, ${s.type}, ${s.id}, ${s.occurrence}, ${mode}, 'matched', ${ctx.userId})
          on conflict (automation_id, subject_type, subject_id, occurrence_key, mode) do nothing
          returning id::text as id
        `)) as unknown as Array<{ id: string }>;
        if (!claimed[0]) {
          summary.skipped++;
          continue;
        }
        const results: Record<string, unknown>[] = [];
        // Each subject runs inside a savepoint so one failing action is recorded
        // on its run row instead of aborting the whole sweep's transaction.
        await tx.execute(sql`savepoint crm_auto_subject`);
        try {
          if (mode === "live")
            for (const action of a.actions)
              results.push(await performActionIn(tx, ctx, a, s, action));
          else results.push(...a.actions.map((x) => ({ wouldDo: x.kind, subject: s.id })));
          await tx.execute(
            sql`update public.crm_automation_run set status = ${mode === "live" ? "applied" : "matched"}, result = ${JSON.stringify(results)}::jsonb where id = ${claimed[0].id}`,
          );
          if (mode === "live") summary.applied++;
          await tx.execute(sql`release savepoint crm_auto_subject`);
        } catch (err) {
          summary.failed++;
          await tx.execute(sql`rollback to savepoint crm_auto_subject`);
          await tx.execute(
            sql`update public.crm_automation_run set status = 'failed', error = ${String((err as Error).message).slice(0, 1000)} where id = ${claimed[0].id}`,
          );
        }
      }
      await tx.execute(
        sql`update public.crm_automation set last_run_at = now() where id = ${a.id} and org_id = ${ctx.orgId}`,
      );
      return summary;
    },
  );
}

/** The daily sweep for one organisation: every enabled, live automation. */
export async function runEnabledAutomations(
  ctx: Ctx,
): Promise<{ automations: number; applied: number }> {
  const list = (await withCtx(ctx, (tx) =>
    tx.execute(
      sql`select id::text as id from public.crm_automation where org_id = ${ctx.orgId} and enabled and not dry_run`,
    ),
  )) as unknown as Array<{ id: string }>;
  let applied = 0;
  for (const a of list) {
    const r = await runAutomation(ctx, "owner", { id: a.id, mode: "live" });
    applied += r.applied;
  }
  return { automations: list.length, applied };
}
