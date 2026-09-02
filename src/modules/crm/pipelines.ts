/**
 * H27 — pipelines, stage settings and governed stage moves (ADR-33, ADR-34).
 *
 * An organisation may run several pipelines; each stage may declare entry
 * requirements (facts the opportunity must carry before it can enter), exit
 * criteria (guidance), a default probability and a maximum age. A stage move
 * is a command: it validates the requirements, refuses a stale row version,
 * records WHO moved it and WHY in the activity history with a structured
 * payload, restamps `stage_entered_at`, and never bypasses the H20 single
 * writers for won/lost.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { ensurePipelineStages, DEFAULT_PIPELINE_STAGES } from "./sales";

export const STAGE_REQUIREMENTS = [
  "value",
  "close_date",
  "customer",
  "contact",
  "stakeholder",
  "next_action",
  "product",
  "quote",
  "decision_criteria",
] as const;
export type StageRequirement = (typeof STAGE_REQUIREMENTS)[number];

const LocaleText = z.object({
  en: z.string().max(200).optional(),
  ar: z.string().max(200).optional(),
});

export type PipelineRow = {
  id: string;
  key: string;
  name: { en?: string; ar?: string };
  kind: "new_business" | "expansion" | "renewal" | "custom";
  isDefault: boolean;
  active: boolean;
  stageCount: number;
};

export type StageSettingsRow = {
  id: string;
  key: string;
  label: { en?: string; ar?: string };
  sort: number;
  category: "open" | "won" | "lost";
  active: boolean;
  pipelineId: string | null;
  requirements: StageRequirement[];
  exitCriteria: { en?: string; ar?: string } | null;
  defaultProbability: number | null;
  maxAgeDays: number | null;
};

export class PipelineError extends Error {
  readonly code: "not_found" | "state" | "conflict" | "requirements" | "validation";
  readonly details?: string[];
  constructor(message: string, code: PipelineError["code"], details?: string[]) {
    super(message);
    this.name = "PipelineError";
    this.code = code;
    this.details = details;
  }
}

/**
 * The organisation's default pipeline exists after the first write path, and
 * every stage without a pipeline joins it. Reads never write (H20 law).
 */
export async function ensurePipelinesIn(tx: TenantTx, ctx: Ctx): Promise<string> {
  await ensurePipelineStages(tx, ctx);
  const rows = (await tx.execute(sql`
    insert into public.crm_pipeline (org_id, key, name, kind, is_default, created_by)
    values (${ctx.orgId}, 'default', '{"en":"Sales","ar":"المبيعات"}'::jsonb, 'new_business', true, ${ctx.userId})
    on conflict (org_id, key) do update set updated_at = now()
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  const id = rows[0]!.id;
  await tx.execute(sql`
    update public.pipeline_stage set pipeline_id = ${id}
    where org_id = ${ctx.orgId} and pipeline_id is null
  `);
  await tx.execute(sql`
    update public.opportunity set pipeline_id = ${id}
    where org_id = ${ctx.orgId} and pipeline_id is null
  `);
  return id;
}

export async function listPipelines(ctx: Ctx, archetype: RoleArchetype): Promise<PipelineRow[]> {
  assertCan(archetype, "opportunities.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select p.id::text as id, p.key, p.name, p.kind, p.is_default, p.active,
             (select count(*)::int from public.pipeline_stage s where s.pipeline_id = p.id and s.active) as stage_count
      from public.crm_pipeline p
      where p.org_id = ${ctx.orgId}
      order by p.is_default desc, p.created_at asc
    `),
  )) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    // Not materialised yet: present the code default so the board never waits on a write.
    return [
      {
        id: "",
        key: "default",
        name: { en: "Sales", ar: "المبيعات" },
        kind: "new_business",
        isDefault: true,
        active: true,
        stageCount: DEFAULT_PIPELINE_STAGES.length,
      },
    ];
  }
  return rows.map((r) => ({
    id: String(r.id),
    key: String(r.key),
    name: (r.name as { en?: string; ar?: string }) ?? {},
    kind: String(r.kind) as PipelineRow["kind"],
    isDefault: Boolean(r.is_default),
    active: Boolean(r.active),
    stageCount: Number(r.stage_count),
  }));
}

export const PipelineInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  name: LocaleText,
  kind: z.enum(["new_business", "expansion", "renewal", "custom"]).default("custom"),
  /** Stages created with the pipeline (open stages; won/lost terminals are shared keys). */
  stages: z
    .array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), label: LocaleText }))
    .min(1)
    .max(12),
});

export async function createPipeline(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "pipeline.configure");
  const input = PipelineInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "crm.pipeline.create",
        entityType: "crm_pipeline",
        entityId: r.id,
        summary: `Created pipeline ${input.key}`,
      }),
    },
    async (tx) => {
      await ensurePipelinesIn(tx, ctx);
      const rows = (await tx.execute(sql`
        insert into public.crm_pipeline (org_id, key, name, kind, created_by)
        values (${ctx.orgId}, ${input.key}, ${JSON.stringify(input.name)}::jsonb, ${input.kind}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const id = rows[0]!.id;
      let sort = 10;
      for (const s of input.stages) {
        const key = `${input.key}_${s.key}`.slice(0, 40);
        await tx.execute(sql`
          insert into public.pipeline_stage (org_id, key, label, sort, category, pipeline_id)
          values (${ctx.orgId}, ${key}, ${JSON.stringify(s.label)}::jsonb, ${sort}, 'open', ${id})
          on conflict (org_id, key) do nothing
        `);
        sort += 10;
      }
      return { id };
    },
  );
}

export const PipelinePatch = z.object({
  id: z.string().uuid(),
  name: LocaleText.optional(),
  kind: z.enum(["new_business", "expansion", "renewal", "custom"]).optional(),
  active: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

export async function updatePipeline(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "pipeline.configure");
  const input = PipelinePatch.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "crm.pipeline.update",
        entityType: "crm_pipeline",
        entityId: input.id,
        summary: "Updated pipeline",
      },
    },
    async (tx) => {
      if (input.isDefault === true)
        await tx.execute(
          sql`update public.crm_pipeline set is_default = false where org_id = ${ctx.orgId} and is_default`,
        );
      await tx.execute(sql`
        update public.crm_pipeline set
          name = coalesce(${input.name ? JSON.stringify(input.name) : null}::jsonb, name),
          kind = coalesce(${input.kind ?? null}, kind),
          active = coalesce(${input.active ?? null}, active),
          is_default = coalesce(${input.isDefault ?? null}, is_default)
        where id = ${input.id} and org_id = ${ctx.orgId}
      `);
    },
  );
}

/** Every stage with its settings (materialised or code default), per pipeline. */
export async function listStageSettings(
  ctx: Ctx,
  archetype: RoleArchetype,
  pipelineId?: string | null,
): Promise<StageSettingsRow[]> {
  assertCan(archetype, "opportunities.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select s.id::text as id, s.key, s.label, s.sort, s.category, s.active, s.pipeline_id::text as pipeline_id,
             s.requirements, s.exit_criteria, s.default_probability, s.max_age_days
      from public.pipeline_stage s
      where s.org_id = ${ctx.orgId}
        and (${pipelineId ?? null}::uuid is null or s.pipeline_id = ${pipelineId ?? null}::uuid or s.pipeline_id is null)
      order by s.sort asc
    `),
  )) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0)
    return DEFAULT_PIPELINE_STAGES.map((s) => ({
      id: "",
      key: s.key,
      label: s.label,
      sort: s.sort,
      category: s.category as StageSettingsRow["category"],
      active: true,
      pipelineId: null,
      requirements: [],
      exitCriteria: null,
      defaultProbability: null,
      maxAgeDays: null,
    }));
  return rows.map((r) => ({
    id: String(r.id),
    key: String(r.key),
    label: (r.label as { en?: string; ar?: string }) ?? {},
    sort: Number(r.sort),
    category: String(r.category) as StageSettingsRow["category"],
    active: Boolean(r.active),
    pipelineId: (r.pipeline_id as string | null) ?? null,
    requirements: (Array.isArray(r.requirements) ? r.requirements : []) as StageRequirement[],
    exitCriteria: (r.exit_criteria as { en?: string; ar?: string } | null) ?? null,
    defaultProbability: r.default_probability === null ? null : Number(r.default_probability),
    maxAgeDays: r.max_age_days === null ? null : Number(r.max_age_days),
  }));
}

export const StageSettingsInput = z.object({
  stageKey: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  requirements: z.array(z.enum(STAGE_REQUIREMENTS)).max(9).optional(),
  exitCriteria: LocaleText.nullable().optional(),
  defaultProbability: z.number().int().min(0).max(100).nullable().optional(),
  maxAgeDays: z.number().int().min(1).max(3650).nullable().optional(),
});

export async function updateStageSettings(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "pipeline.configure");
  const input = StageSettingsInput.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "crm.stage.settings",
        entityType: "crm_pipeline",
        summary: `Stage ${input.stageKey} settings`,
      },
    },
    async (tx) => {
      await ensurePipelinesIn(tx, ctx);
      await tx.execute(sql`
        update public.pipeline_stage set
          requirements = coalesce(${input.requirements ? JSON.stringify(input.requirements) : null}::jsonb, requirements),
          exit_criteria = case when ${input.exitCriteria === undefined} then exit_criteria
                               else ${input.exitCriteria ? JSON.stringify(input.exitCriteria) : null}::jsonb end,
          default_probability = case when ${input.defaultProbability === undefined} then default_probability
                                     else ${input.defaultProbability ?? null} end,
          max_age_days = case when ${input.maxAgeDays === undefined} then max_age_days
                              else ${input.maxAgeDays ?? null} end,
          updated_at = now()
        where org_id = ${ctx.orgId} and key = ${input.stageKey}
      `);
    },
  );
}

/** Facts a stage requirement can check, gathered from the opportunity and its satellites. */
export type OpportunityFacts = {
  valueMinor: number | null;
  closeDate: string | null;
  customerId: string | null;
  contactCount: number;
  stakeholderCount: number;
  nextAction: string | null;
  productCount: number;
  quoteId: string | null;
  decisionCriteria: string | null;
};

/** Pure: which requirements are unmet. */
export function unmetRequirements(
  reqs: StageRequirement[],
  f: OpportunityFacts,
): StageRequirement[] {
  const out: StageRequirement[] = [];
  for (const r of reqs) {
    const ok =
      r === "value"
        ? f.valueMinor !== null && f.valueMinor > 0
        : r === "close_date"
          ? f.closeDate !== null
          : r === "customer"
            ? f.customerId !== null
            : r === "contact"
              ? f.contactCount > 0
              : r === "stakeholder"
                ? f.stakeholderCount > 0
                : r === "next_action"
                  ? f.nextAction !== null && f.nextAction.trim().length > 0
                  : r === "product"
                    ? f.productCount > 0
                    : r === "quote"
                      ? f.quoteId !== null
                      : f.decisionCriteria !== null && f.decisionCriteria.trim().length > 0;
    if (!ok) out.push(r);
  }
  return out;
}

export async function opportunityFactsIn(
  tx: TenantTx,
  ctx: Ctx,
  id: string,
): Promise<OpportunityFacts | null> {
  const rows = (await tx.execute(sql`
    select o.estimated_value_minor, o.expected_close_date::text as close_date, o.customer_id::text as customer_id,
           o.next_action, o.quote_id::text as quote_id, o.decision_criteria,
           (select count(*)::int from public.customer_contact cc where cc.org_id = o.org_id and cc.customer_id = o.customer_id and cc.active) as contact_count,
           (select count(*)::int from public.crm_opportunity_stakeholder s where s.org_id = o.org_id and s.opportunity_id = o.id) as stakeholder_count,
           (select count(*)::int from public.crm_opportunity_product p where p.org_id = o.org_id and p.opportunity_id = o.id) as product_count
    from public.opportunity o
    where o.id = ${id} and o.org_id = ${ctx.orgId}
  `)) as unknown as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  return {
    valueMinor: r.estimated_value_minor === null ? null : Number(r.estimated_value_minor),
    closeDate: (r.close_date as string | null) ?? null,
    customerId: (r.customer_id as string | null) ?? null,
    contactCount: Number(r.contact_count),
    stakeholderCount: Number(r.stakeholder_count),
    nextAction: (r.next_action as string | null) ?? null,
    productCount: Number(r.product_count),
    quoteId: (r.quote_id as string | null) ?? null,
    decisionCriteria: (r.decision_criteria as string | null) ?? null,
  };
}

export const MoveStageInput = z.object({
  id: z.string().uuid(),
  stageKey: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  rowVersion: z.number().int().min(1),
  reason: z.string().trim().max(500).optional().nullable(),
});

/**
 * Governed stage move: requirements validated, stale rows refused, the move
 * recorded with who/why/how long the previous stage lasted. Won/lost stay
 * with H20's winOpportunity/loseOpportunity.
 */
export async function moveStage(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{
  moved: boolean;
  rowVersion: number;
  from: string;
  to: string;
  unmet: StageRequirement[];
}> {
  assertCan(archetype, "opportunities.manage");
  const input = MoveStageInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: { moved: boolean; from: string; to: string }) => ({
        action: "opportunity.stage",
        entityType: "opportunity",
        entityId: input.id,
        summary: r.moved
          ? `Moved ${r.from} → ${r.to}${input.reason ? `: ${input.reason}` : ""}`
          : "Stage unchanged",
      }),
    },
    async (tx) => {
      await ensurePipelinesIn(tx, ctx);
      const target = (await tx.execute(sql`
        select requirements from public.pipeline_stage
        where org_id = ${ctx.orgId} and key = ${input.stageKey} and category = 'open' and active = true
      `)) as unknown as Array<{ requirements: unknown }>;
      if (!target[0]) throw new PipelineError("stage not found or not open", "not_found");
      const current = (await tx.execute(sql`
        select stage_key, status, row_version, stage_entered_at::text as entered from public.opportunity
        where id = ${input.id} and org_id = ${ctx.orgId} and archived = false
        for update
      `)) as unknown as Array<{
        stage_key: string;
        status: string;
        row_version: number;
        entered: string;
      }>;
      const cur = current[0];
      if (!cur) throw new PipelineError("opportunity not found", "not_found");
      if (cur.status !== "open") throw new PipelineError("only an open opportunity moves", "state");
      if (Number(cur.row_version) !== input.rowVersion)
        throw new PipelineError("the opportunity changed; reload and try again", "conflict");
      if (cur.stage_key === input.stageKey)
        return {
          moved: false,
          rowVersion: Number(cur.row_version),
          from: cur.stage_key,
          to: input.stageKey,
          unmet: [],
        };
      const reqs = (
        Array.isArray(target[0].requirements) ? target[0].requirements : []
      ) as StageRequirement[];
      const facts = await opportunityFactsIn(tx, ctx, input.id);
      const unmet = facts ? unmetRequirements(reqs, facts) : reqs;
      if (unmet.length > 0)
        throw new PipelineError(
          `stage requirements not met: ${unmet.join(", ")}`,
          "requirements",
          unmet,
        );
      const ageDays = Math.max(
        0,
        Math.floor((Date.now() - new Date(cur.entered).getTime()) / 86_400_000),
      );
      const rows = (await tx.execute(sql`
        update public.opportunity
        set stage_key = ${input.stageKey}, stage_entered_at = now(), last_activity_at = now(),
            row_version = row_version + 1, updated_at = now()
        where id = ${input.id} and org_id = ${ctx.orgId}
        returning row_version
      `)) as unknown as Array<{ row_version: number }>;
      await tx.execute(sql`
        insert into public.sales_activity (org_id, opportunity_id, kind, title, body, actor_user_id, meta)
        values (${ctx.orgId}, ${input.id}, 'stage_change', ${`${cur.stage_key}|${input.stageKey}`}, ${input.reason ?? null}, ${ctx.userId},
                ${JSON.stringify({ from: cur.stage_key, to: input.stageKey, reason: input.reason ?? null, ageDays })}::jsonb)
      `);
      return {
        moved: true,
        rowVersion: Number(rows[0]!.row_version),
        from: cur.stage_key,
        to: input.stageKey,
        unmet: [],
      };
    },
  );
}

// ── the paged board and list: database-side filtering, full-result aggregates ─
export const BoardQuery = z.object({
  pipelineId: z.string().uuid().optional().nullable(),
  status: z.enum(["open", "won", "lost", "all"]).default("open"),
  search: z.string().trim().max(200).optional(),
  ownerUserId: z.string().uuid().optional().nullable(),
  customerId: z.string().uuid().optional().nullable(),
  forecastCategory: z.enum(["pipeline", "best_case", "commit", "omitted"]).optional().nullable(),
  stageKey: z.string().optional().nullable(),
  closingFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  closingTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  stalledDays: z.number().int().min(1).max(3650).optional().nullable(),
  sort: z.enum(["close", "value", "updated", "age", "name"]).default("close"),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type BoardQuery = z.infer<typeof BoardQuery>;

export type BoardCard = {
  id: string;
  name: string;
  customerId: string | null;
  customerName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  stageKey: string;
  status: "open" | "won" | "lost";
  forecastCategory: "pipeline" | "best_case" | "commit" | "omitted";
  kind: "new_business" | "expansion" | "renewal";
  estimatedValueMinor: number | null;
  currency: string | null;
  probability: number | null;
  expectedCloseDate: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  stageAgeDays: number;
  inactiveDays: number | null;
  stakeholderCount: number;
  openRiskCount: number;
  quoteId: string | null;
  rowVersion: number;
  updatedAt: string;
};

export type StageAggregate = {
  stageKey: string;
  count: number;
  valueMinor: number | null;
  weightedMinor: number | null;
  avgAgeDays: number;
  stalled: number;
};

export type BoardPage = {
  rows: BoardCard[];
  total: number;
  /** Aggregates across the FULL filtered result, never the page. */
  stages: StageAggregate[];
  totals: { count: number; valueMinor: number | null; weightedMinor: number | null };
};

function boardWhere(ctx: Ctx, q: BoardQuery) {
  const status = q.status === "all" ? null : q.status;
  const search = q.search ? `%${q.search}%` : null;
  return sql`
    o.org_id = ${ctx.orgId} and o.archived = false
    and (${status}::text is null or o.status = ${status})
    and (${q.pipelineId ?? null}::uuid is null or o.pipeline_id = ${q.pipelineId ?? null}::uuid)
    and (${search}::text is null or o.name ilike ${search} or c.name ilike ${search})
    and (${q.ownerUserId ?? null}::uuid is null or o.owner_user_id = ${q.ownerUserId ?? null}::uuid)
    and (${q.customerId ?? null}::uuid is null or o.customer_id = ${q.customerId ?? null}::uuid)
    and (${q.forecastCategory ?? null}::text is null or o.forecast_category = ${q.forecastCategory ?? null})
    and (${q.stageKey ?? null}::text is null or o.stage_key = ${q.stageKey ?? null})
    and (${q.closingFrom ?? null}::date is null or o.expected_close_date >= ${q.closingFrom ?? null}::date)
    and (${q.closingTo ?? null}::date is null or o.expected_close_date <= ${q.closingTo ?? null}::date)
    and (${q.stalledDays ?? null}::int is null or (o.status = 'open' and coalesce(o.last_activity_at, o.stage_entered_at) < now() - make_interval(days => ${q.stalledDays ?? 0})))
  `;
}

export async function boardPage(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<BoardPage> {
  assertCan(archetype, "opportunities.view");
  const q = BoardQuery.parse(raw ?? {});
  const seesPrice = ctx.pricePrivileged;
  const order =
    q.sort === "value"
      ? sql`o.estimated_value_minor desc nulls last, o.created_at desc`
      : q.sort === "updated"
        ? sql`o.updated_at desc`
        : q.sort === "age"
          ? sql`o.stage_entered_at asc`
          : q.sort === "name"
            ? sql`o.name asc`
            : sql`o.expected_close_date asc nulls last, o.created_at desc`;
  return withCtx(ctx, async (tx) => {
    const where = boardWhere(ctx, q);
    const rows = (await tx.execute(sql`
      select o.id::text as id, o.name, o.customer_id::text as customer_id, c.name as customer_name,
             o.owner_user_id::text as owner_user_id, u.full_name as owner_name, o.stage_key, o.status,
             o.forecast_category, o.kind, o.estimated_value_minor, o.currency, o.probability,
             o.expected_close_date::text as expected_close_date, o.next_action, o.next_action_due::text as next_action_due,
             greatest(0, extract(day from now() - o.stage_entered_at))::int as stage_age_days,
             case when o.last_activity_at is null then null else greatest(0, extract(day from now() - o.last_activity_at))::int end as inactive_days,
             (select count(*)::int from public.crm_opportunity_stakeholder s where s.org_id = o.org_id and s.opportunity_id = o.id) as stakeholder_count,
             (select count(*)::int from public.crm_opportunity_risk r where r.org_id = o.org_id and r.opportunity_id = o.id and r.status = 'open') as open_risk_count,
             o.quote_id::text as quote_id, o.row_version, o.updated_at::text as updated_at
      from public.opportunity o
      left join public.customer c on c.id = o.customer_id
      left join public.user_profile u on u.id = o.owner_user_id
      where ${where}
      order by ${order}
      limit ${q.limit} offset ${q.offset}
    `)) as unknown as Array<Record<string, unknown>>;
    const agg = (await tx.execute(sql`
      select o.stage_key, count(*)::int as n,
             sum(o.estimated_value_minor)::bigint as value_minor,
             sum(o.estimated_value_minor * coalesce(o.probability, s.default_probability, 0) / 100.0)::bigint as weighted_minor,
             coalesce(avg(greatest(0, extract(day from now() - o.stage_entered_at))), 0)::int as avg_age,
             sum(case when s.max_age_days is not null and o.stage_entered_at < now() - make_interval(days => s.max_age_days) then 1 else 0 end)::int as stalled
      from public.opportunity o
      left join public.customer c on c.id = o.customer_id
      left join public.pipeline_stage s on s.org_id = o.org_id and s.key = o.stage_key
      where ${where}
      group by o.stage_key
    `)) as unknown as Array<Record<string, unknown>>;
    const stages = agg.map((r) => ({
      stageKey: String(r.stage_key),
      count: Number(r.n),
      valueMinor: seesPrice ? Number(r.value_minor ?? 0) : null,
      weightedMinor: seesPrice ? Number(r.weighted_minor ?? 0) : null,
      avgAgeDays: Number(r.avg_age),
      stalled: Number(r.stalled),
    }));
    const total = stages.reduce((s, x) => s + x.count, 0);
    return {
      rows: rows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        customerId: (r.customer_id as string | null) ?? null,
        customerName: (r.customer_name as string | null) ?? null,
        ownerUserId: (r.owner_user_id as string | null) ?? null,
        ownerName: (r.owner_name as string | null) ?? null,
        stageKey: String(r.stage_key),
        status: String(r.status) as BoardCard["status"],
        forecastCategory: String(r.forecast_category) as BoardCard["forecastCategory"],
        kind: String(r.kind) as BoardCard["kind"],
        estimatedValueMinor:
          seesPrice && r.estimated_value_minor !== null ? Number(r.estimated_value_minor) : null,
        currency: (r.currency as string | null) ?? null,
        probability: r.probability === null ? null : Number(r.probability),
        expectedCloseDate: (r.expected_close_date as string | null) ?? null,
        nextAction: (r.next_action as string | null) ?? null,
        nextActionDue: (r.next_action_due as string | null) ?? null,
        stageAgeDays: Number(r.stage_age_days),
        inactiveDays: r.inactive_days === null ? null : Number(r.inactive_days),
        stakeholderCount: Number(r.stakeholder_count),
        openRiskCount: Number(r.open_risk_count),
        quoteId: (r.quote_id as string | null) ?? null,
        rowVersion: Number(r.row_version),
        updatedAt: String(r.updated_at),
      })),
      total,
      stages,
      totals: {
        count: total,
        valueMinor: seesPrice ? stages.reduce((s, x) => s + (x.valueMinor ?? 0), 0) : null,
        weightedMinor: seesPrice ? stages.reduce((s, x) => s + (x.weightedMinor ?? 0), 0) : null,
      },
    };
  });
}
