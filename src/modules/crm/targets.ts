/**
 * H27 — territories, targets and performance (ADR-39). A territory is a
 * named rule set (countries, tags) that suggests ownership; a target is a
 * dated row per scope, metric and period (changes append rows, history
 * stays); progress is computed on read from the owning modules and always
 * explains what it counted. No activity surveillance: activity targets count
 * completed, outcome-bearing engagements, not keystrokes.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LocaleText = z.object({
  en: z.string().max(120).optional(),
  ar: z.string().max(120).optional(),
});

export const TerritoryInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  name: LocaleText,
  rules: z
    .object({
      countries: z
        .array(z.string().regex(/^[A-Z]{2}$/))
        .max(50)
        .optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
      segments: z.array(z.string().max(40)).max(20).optional(),
    })
    .default({}),
  ownerUserId: uuid.optional().nullable(),
});

export type TerritoryRow = {
  id: string;
  key: string;
  name: { en?: string; ar?: string };
  rules: { countries?: string[]; tags?: string[]; segments?: string[] };
  ownerUserId: string | null;
  ownerName: string | null;
  active: boolean;
  customers: number;
};

export async function createTerritory(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "crm.targets.manage");
  const input = TerritoryInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "crm.territory.create",
        entityType: "crm_territory",
        entityId: r.id,
        summary: input.key,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.crm_territory (org_id, key, name, rules, owner_user_id, created_by)
        values (${ctx.orgId}, ${input.key}, ${JSON.stringify(input.name)}::jsonb, ${JSON.stringify(input.rules)}::jsonb, ${input.ownerUserId ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export async function updateTerritory(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "crm.targets.manage");
  // Explicit patch: never re-applies TerritoryInput defaults (rules would reset to {}).
  const input = z
    .object({
      id: uuid,
      key: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,39}$/)
        .optional(),
      name: LocaleText.optional(),
      rules: z
        .object({
          countries: z
            .array(z.string().regex(/^[A-Z]{2}$/))
            .max(50)
            .optional(),
          tags: z.array(z.string().max(40)).max(20).optional(),
          segments: z.array(z.string().max(40)).max(20).optional(),
        })
        .optional(),
      ownerUserId: uuid.optional().nullable(),
      active: z.boolean().optional(),
    })
    .parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "crm.territory.update",
        entityType: "crm_territory",
        entityId: input.id,
        summary: "Territory updated",
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.crm_territory set
          name = coalesce(${input.name ? JSON.stringify(input.name) : null}::jsonb, name),
          rules = coalesce(${input.rules ? JSON.stringify(input.rules) : null}::jsonb, rules),
          owner_user_id = case when ${input.ownerUserId === undefined} then owner_user_id else ${input.ownerUserId ?? null}::uuid end,
          active = coalesce(${input.active ?? null}, active)
        where id = ${input.id} and org_id = ${ctx.orgId}
      `);
    },
  );
}

export async function listTerritories(ctx: Ctx, archetype: RoleArchetype): Promise<TerritoryRow[]> {
  assertCan(archetype, "customers.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select t.id::text as id, t.key, t.name, t.rules, t.owner_user_id::text as owner_user_id, u.full_name as owner_name, t.active,
             (select count(*)::int from public.customer c where c.org_id = t.org_id and c.territory_id = t.id) as customers
      from public.crm_territory t left join public.user_profile u on u.id = t.owner_user_id
      where t.org_id = ${ctx.orgId} order by t.key asc
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    key: String(r.key),
    name: (r.name as TerritoryRow["name"]) ?? {},
    rules: (r.rules as TerritoryRow["rules"]) ?? {},
    ownerUserId: (r.owner_user_id as string | null) ?? null,
    ownerName: (r.owner_name as string | null) ?? null,
    active: Boolean(r.active),
    customers: Number(r.customers),
  }));
}

/** Pure: the first territory whose rules match the customer facts (countries first, then tags/segments). */
export function matchTerritory(
  territories: Array<{ id: string; rules: TerritoryRow["rules"]; active: boolean }>,
  facts: { country: string | null; tags: string[]; segment: string | null },
): string | null {
  for (const t of territories) {
    if (!t.active) continue;
    const r = t.rules;
    const byCountry = r.countries?.length
      ? facts.country
        ? r.countries.includes(facts.country)
        : false
      : null;
    const byTag = r.tags?.length ? r.tags.some((x) => facts.tags.includes(x)) : null;
    const bySeg = r.segments?.length
      ? facts.segment
        ? r.segments.includes(facts.segment)
        : false
      : null;
    const checks = [byCountry, byTag, bySeg].filter((x) => x !== null);
    if (checks.length > 0 && checks.every(Boolean)) return t.id;
  }
  return null;
}

/** Assign territories to customers that have none, by the rules; returns how many changed. A reviewed action, never automatic. */
export async function applyTerritoryRules(
  ctx: Ctx,
  archetype: RoleArchetype,
  dryRun = true,
): Promise<{ matched: number; applied: number; unmatched: number }> {
  assertCan(archetype, "crm.targets.manage");
  const territories = await listTerritories(ctx, archetype);
  return command(
    ctx,
    {
      audit: {
        action: "crm.territory.apply",
        entityType: "crm_territory",
        summary: dryRun ? "dry run" : "applied",
      },
    },
    async (tx) => {
      const customers = (await tx.execute(sql`
        select id::text as id, country, tags, segment from public.customer
        where org_id = ${ctx.orgId} and territory_id is null and active and merged_into_customer_id is null
        limit 2000
      `)) as unknown as Array<{
        id: string;
        country: string | null;
        tags: string[];
        segment: string | null;
      }>;
      let matched = 0;
      let applied = 0;
      for (const c of customers) {
        const t = matchTerritory(territories, {
          country: c.country,
          tags: c.tags ?? [],
          segment: c.segment,
        });
        if (!t) continue;
        matched++;
        if (!dryRun) {
          await tx.execute(
            sql`update public.customer set territory_id = ${t}, updated_at = now() where id = ${c.id} and org_id = ${ctx.orgId}`,
          );
          applied++;
        }
      }
      return { matched, applied, unmatched: customers.length - matched };
    },
  );
}

export const TargetInput = z
  .object({
    scopeKind: z.enum(["org", "team", "user", "territory"]),
    scopeId: uuid.optional().nullable(),
    metric: z.enum(["revenue", "bookings", "margin", "activities", "new_customers"]),
    periodStart: isoDate,
    periodEnd: isoDate,
    amountMinor: z.number().int().min(0).optional().nullable(),
    countTarget: z.number().int().min(0).optional().nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional()
      .nullable(),
    effectiveFrom: isoDate.optional(),
    note: z.string().trim().max(500).optional().nullable(),
  })
  .refine((v) => (v.scopeKind === "org") === !v.scopeId, {
    message: "scope id required except for org",
  })
  .refine(
    (v) =>
      ["activities", "new_customers"].includes(v.metric)
        ? v.countTarget !== null && v.countTarget !== undefined
        : v.amountMinor !== null && v.amountMinor !== undefined && !!v.currency,
    {
      message: "count for activity metrics; amount and currency for money metrics",
    },
  );

export async function setTarget(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "crm.targets.manage");
  const input = TargetInput.parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "crm.target.set",
        entityType: "crm_target",
        entityId: r.id,
        summary: `${input.metric} ${input.scopeKind} ${input.periodStart}..${input.periodEnd}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.crm_target (org_id, scope_kind, scope_id, metric, period_start, period_end, amount_minor, count_target, currency, effective_from, note, created_by)
        values (${ctx.orgId}, ${input.scopeKind}, ${input.scopeId ?? null}, ${input.metric}, ${input.periodStart}::date, ${input.periodEnd}::date,
                ${input.amountMinor ?? null}, ${input.countTarget ?? null}, ${input.currency ?? null}, coalesce(${input.effectiveFrom ?? null}::date, current_date), ${input.note ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export type TargetProgress = {
  id: string;
  scopeKind: string;
  scopeId: string | null;
  scopeName: string | null;
  metric: string;
  periodStart: string;
  periodEnd: string;
  targetMinor: number | null;
  targetCount: number | null;
  currency: string | null;
  actualMinor: number | null;
  actualCount: number | null;
  progressPct: number | null;
  /** What the actual figure counted, in words. */
  basis: string;
  effectiveFrom: string;
};

/** The effective target per scope/metric/period (latest effective_from wins) with computed progress. */
export async function targetProgress(
  ctx: Ctx,
  archetype: RoleArchetype,
  asOf?: string,
): Promise<TargetProgress[]> {
  assertCan(archetype, "crm.forecast.view");
  const day = asOf ?? new Date().toISOString().slice(0, 10);
  return withCtx(ctx, async (tx) => {
    const targets = (await tx.execute(sql`
      select distinct on (t.scope_kind, t.scope_id, t.metric, t.period_start, t.period_end)
             t.id::text as id, t.scope_kind, t.scope_id::text as scope_id, t.metric, t.period_start::text as period_start, t.period_end::text as period_end,
             t.amount_minor, t.count_target, t.currency, t.effective_from::text as effective_from,
             coalesce(u.full_name, tm.name, tr.name->>'en') as scope_name
      from public.crm_target t
      left join public.user_profile u on t.scope_kind = 'user' and u.id = t.scope_id
      left join public.team tm on t.scope_kind = 'team' and tm.id = t.scope_id
      left join public.crm_territory tr on t.scope_kind = 'territory' and tr.id = t.scope_id
      where t.org_id = ${ctx.orgId} and t.effective_from <= ${day}::date and t.period_end >= (${day}::date - 400)
      order by t.scope_kind, t.scope_id, t.metric, t.period_start, t.period_end, t.effective_from desc
    `)) as unknown as Array<Record<string, unknown>>;
    const out: TargetProgress[] = [];
    for (const t of targets) {
      const scopeKind = String(t.scope_kind);
      const scopeId = (t.scope_id as string | null) ?? null;
      const metric = String(t.metric);
      const ps = String(t.period_start);
      const pe = String(t.period_end);
      // Scope filter on opportunities/customers/activities.
      const scopeOpp =
        scopeKind === "user"
          ? sql`and o.owner_user_id = ${scopeId}::uuid`
          : scopeKind === "team"
            ? sql`and o.owner_user_id in (select e.user_id from public.employee e where e.org_id = o.org_id and e.team_id = ${scopeId}::uuid and e.user_id is not null)`
            : scopeKind === "territory"
              ? sql`and o.territory_id = ${scopeId}::uuid`
              : sql``;
      let actualMinor: number | null = null;
      let actualCount: number | null = null;
      let basis = "";
      if (metric === "bookings" || metric === "revenue" || metric === "margin") {
        const r = (await tx.execute(sql`
          select coalesce(sum(o.estimated_value_minor), 0)::bigint as minor, count(*)::int as n
          from public.opportunity o
          where o.org_id = ${ctx.orgId} and o.status = 'won' and o.won_at >= ${ps}::date and o.won_at < (${pe}::date + 1) ${scopeOpp}
        `)) as unknown as Array<{ minor: number; n: number }>;
        if (metric === "revenue") {
          const inv = (await tx.execute(sql`
            select coalesce(sum(i.total_minor), 0)::bigint as minor, count(*)::int as n
            from public.invoice i
            where i.org_id = ${ctx.orgId} and i.status in ('issued', 'partially_paid', 'paid') and i.issued_at >= ${ps}::date and i.issued_at < (${pe}::date + 1)
              ${scopeKind === "user" ? sql`and i.customer_id in (select c.id from public.customer c where c.org_id = i.org_id and c.owner_user_id = ${scopeId}::uuid)` : scopeKind === "territory" ? sql`and i.customer_id in (select c.id from public.customer c where c.org_id = i.org_id and c.territory_id = ${scopeId}::uuid)` : sql``}
          `)) as unknown as Array<{ minor: number; n: number }>;
          actualMinor = ctx.pricePrivileged ? Number(inv[0]?.minor ?? 0) : null;
          basis = `${inv[0]?.n ?? 0} invoices issued in the period (customer owner or territory scope; team scope reads bookings)`;
        } else if (metric === "margin") {
          const m = (await tx.execute(sql`
            select coalesce(sum(p.qty * (p.unit_price_minor * (1 - p.discount_pct / 100.0) - coalesce(p.unit_cost_minor, 0))), 0)::bigint as minor, count(distinct o.id)::int as n
            from public.opportunity o join public.crm_opportunity_product p on p.org_id = o.org_id and p.opportunity_id = o.id and not p.optional
            where o.org_id = ${ctx.orgId} and o.status = 'won' and o.won_at >= ${ps}::date and o.won_at < (${pe}::date + 1) ${scopeOpp}
          `)) as unknown as Array<{ minor: number; n: number }>;
          actualMinor = ctx.costPrivileged && ctx.pricePrivileged ? Number(m[0]?.minor ?? 0) : null;
          basis = `estimated margin on ${m[0]?.n ?? 0} won opportunities with priced lines and known cost`;
        } else {
          actualMinor = ctx.pricePrivileged ? Number(r[0]?.minor ?? 0) : null;
          basis = `${r[0]?.n ?? 0} opportunities won in the period (estimated value at win)`;
        }
      } else if (metric === "activities") {
        const a = (await tx.execute(sql`
          select count(*)::int as n from public.sales_activity a
          where a.org_id = ${ctx.orgId} and a.completed_at >= ${ps}::date and a.completed_at < (${pe}::date + 1)
            and a.kind in ('call', 'meeting', 'site_visit', 'demo', 'email', 'message') and a.outcome is not null
            ${scopeKind === "user" ? sql`and a.completed_by = ${scopeId}::uuid` : sql``}
        `)) as unknown as Array<{ n: number }>;
        actualCount = Number(a[0]?.n ?? 0);
        basis =
          "completed engagements with a recorded outcome (calls, meetings, visits, demonstrations, emails, messages)";
      } else {
        const c = (await tx.execute(sql`
          select count(*)::int as n from public.customer c
          where c.org_id = ${ctx.orgId} and c.created_at >= ${ps}::date and c.created_at < (${pe}::date + 1)
            ${scopeKind === "user" ? sql`and c.owner_user_id = ${scopeId}::uuid` : scopeKind === "territory" ? sql`and c.territory_id = ${scopeId}::uuid` : sql``}
        `)) as unknown as Array<{ n: number }>;
        actualCount = Number(c[0]?.n ?? 0);
        basis = "customers created in the period";
      }
      const targetMinor = t.amount_minor === null ? null : Number(t.amount_minor);
      const targetCount = t.count_target === null ? null : Number(t.count_target);
      const progressPct =
        targetMinor !== null && targetMinor > 0 && actualMinor !== null
          ? Math.round((actualMinor / targetMinor) * 100)
          : targetCount !== null && targetCount > 0 && actualCount !== null
            ? Math.round((actualCount / targetCount) * 100)
            : null;
      out.push({
        id: String(t.id),
        scopeKind,
        scopeId,
        scopeName: (t.scope_name as string | null) ?? null,
        metric,
        periodStart: ps,
        periodEnd: pe,
        targetMinor: ctx.pricePrivileged ? targetMinor : null,
        targetCount,
        currency: (t.currency as string | null) ?? null,
        actualMinor,
        actualCount,
        progressPct,
        basis,
        effectiveFrom: String(t.effective_from),
      });
    }
    return out;
  });
}
