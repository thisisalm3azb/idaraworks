/**
 * H27 — campaigns and attribution (ADR-40). A campaign has objectives, an
 * audience description, channel, budget and cost; touches record which
 * campaign reached which lead, customer or opportunity. Attribution is
 * computed on read under three NAMED models (first_touch, last_touch,
 * linear) and never presented as causal impact.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CampaignInput = z.object({
  name: z.string().trim().min(1).max(160),
  objective: z.string().trim().max(1000).optional().nullable(),
  channel: z
    .enum([
      "email",
      "sms",
      "whatsapp",
      "social",
      "event",
      "referral",
      "web",
      "ads",
      "phone",
      "other",
    ])
    .default("other"),
  status: z.enum(["planned", "active", "paused", "completed", "cancelled"]).default("planned"),
  audience: z
    .object({
      segments: z.array(z.string().max(40)).max(20).optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
      territories: z.array(uuid).max(20).optional(),
      note: z.string().max(500).optional(),
    })
    .default({}),
  budgetMinor: z.number().int().min(0).optional().nullable(),
  costMinor: z.number().int().min(0).default(0),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional()
    .nullable(),
  startsOn: isoDate.optional().nullable(),
  endsOn: isoDate.optional().nullable(),
  ownerUserId: uuid.optional().nullable(),
});

export type CampaignRow = {
  id: string;
  name: string;
  objective: string | null;
  channel: string;
  status: string;
  audience: Record<string, unknown>;
  budgetMinor: number | null;
  costMinor: number;
  currency: string | null;
  startsOn: string | null;
  endsOn: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  leads: number;
  opportunities: number;
  wonMinor: number | null;
  createdAt: string;
};

export async function createCampaign(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "crm.campaigns.manage");
  const input = CampaignInput.parse(raw);
  if ((input.budgetMinor !== null && input.budgetMinor !== undefined) || input.costMinor > 0) {
    if (!input.currency) throw new Error("a budget or cost needs a currency");
  }
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "crm.campaign.create",
        entityType: "crm_campaign",
        entityId: r.id,
        summary: input.name,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.crm_campaign (org_id, name, objective, channel, status, audience, budget_minor, cost_minor, currency, starts_on, ends_on, owner_user_id, created_by)
        values (${ctx.orgId}, ${input.name}, ${input.objective ?? null}, ${input.channel}, ${input.status}, ${JSON.stringify(input.audience)}::jsonb,
                ${input.budgetMinor ?? null}, ${input.costMinor}, ${input.currency ?? null}, ${input.startsOn ?? null}::date, ${input.endsOn ?? null}::date,
                ${input.ownerUserId ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

/** Explicit patch: a partial update never re-applies the input defaults (channel, status, cost). */
export const CampaignPatch = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(160).optional(),
  objective: z.string().trim().max(1000).optional().nullable(),
  channel: z
    .enum([
      "email",
      "sms",
      "whatsapp",
      "social",
      "event",
      "referral",
      "web",
      "ads",
      "phone",
      "other",
    ])
    .optional(),
  status: z.enum(["planned", "active", "paused", "completed", "cancelled"]).optional(),
  audience: z
    .object({
      segments: z.array(z.string().max(40)).max(20).optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
      territories: z.array(uuid).max(20).optional(),
      note: z.string().max(500).optional(),
    })
    .optional(),
  budgetMinor: z.number().int().min(0).optional().nullable(),
  costMinor: z.number().int().min(0).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional()
    .nullable(),
  startsOn: isoDate.optional().nullable(),
  endsOn: isoDate.optional().nullable(),
  ownerUserId: uuid.optional().nullable(),
});

export async function updateCampaign(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<void> {
  assertCan(archetype, "crm.campaigns.manage");
  const input = CampaignPatch.parse(raw);
  await command(
    ctx,
    {
      audit: {
        action: "crm.campaign.update",
        entityType: "crm_campaign",
        entityId: input.id,
        summary: "Campaign updated",
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.crm_campaign set
          name = coalesce(${input.name ?? null}, name),
          objective = case when ${input.objective === undefined} then objective else ${input.objective ?? null} end,
          channel = coalesce(${input.channel ?? null}, channel),
          status = coalesce(${input.status ?? null}, status),
          audience = coalesce(${input.audience ? JSON.stringify(input.audience) : null}::jsonb, audience),
          budget_minor = case when ${input.budgetMinor === undefined} then budget_minor else ${input.budgetMinor ?? null} end,
          cost_minor = coalesce(${input.costMinor ?? null}, cost_minor),
          currency = case when ${input.currency === undefined} then currency else ${input.currency ?? null} end,
          starts_on = case when ${input.startsOn === undefined} then starts_on else ${input.startsOn ?? null}::date end,
          ends_on = case when ${input.endsOn === undefined} then ends_on else ${input.endsOn ?? null}::date end,
          owner_user_id = case when ${input.ownerUserId === undefined} then owner_user_id else ${input.ownerUserId ?? null}::uuid end
        where id = ${input.id} and org_id = ${ctx.orgId}
      `);
    },
  );
}

export async function listCampaigns(ctx: Ctx, archetype: RoleArchetype): Promise<CampaignRow[]> {
  assertCan(archetype, "leads.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select c.id::text as id, c.name, c.objective, c.channel, c.status, c.audience, c.budget_minor, c.cost_minor, c.currency,
             c.starts_on::text as starts_on, c.ends_on::text as ends_on, c.owner_user_id::text as owner_user_id, u.full_name as owner_name,
             (select count(*)::int from public.lead l where l.org_id = c.org_id and l.campaign_id = c.id) as leads,
             (select count(*)::int from public.opportunity o where o.org_id = c.org_id and o.campaign_id = c.id) as opportunities,
             (select coalesce(sum(o.estimated_value_minor), 0)::bigint from public.opportunity o where o.org_id = c.org_id and o.campaign_id = c.id and o.status = 'won') as won_minor,
             c.created_at::text as created_at
      from public.crm_campaign c left join public.user_profile u on u.id = c.owner_user_id
      where c.org_id = ${ctx.orgId}
      order by c.starts_on desc nulls last, c.created_at desc
      limit 300
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    objective: (r.objective as string | null) ?? null,
    channel: String(r.channel),
    status: String(r.status),
    audience: (r.audience as Record<string, unknown>) ?? {},
    budgetMinor: r.budget_minor === null ? null : Number(r.budget_minor),
    costMinor: Number(r.cost_minor),
    currency: (r.currency as string | null) ?? null,
    startsOn: (r.starts_on as string | null) ?? null,
    endsOn: (r.ends_on as string | null) ?? null,
    ownerUserId: (r.owner_user_id as string | null) ?? null,
    ownerName: (r.owner_name as string | null) ?? null,
    leads: Number(r.leads),
    opportunities: Number(r.opportunities),
    wonMinor: ctx.pricePrivileged ? Number(r.won_minor) : null,
    createdAt: String(r.created_at),
  }));
}

export const TouchInput = z.object({
  campaignId: uuid,
  customerId: uuid.optional().nullable(),
  leadId: uuid.optional().nullable(),
  opportunityId: uuid.optional().nullable(),
  kind: z.enum(["exposure", "click", "reply", "visit", "referral", "manual"]).default("manual"),
  touchedAt: z.string().datetime().optional(),
  note: z.string().trim().max(300).optional().nullable(),
});

export async function recordTouch(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "leads.manage");
  const input = TouchInput.parse(raw);
  if (!input.customerId && !input.leadId && !input.opportunityId)
    throw new Error("a touch needs a subject");
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "crm.touch.record",
        entityType: "crm_campaign",
        entityId: input.campaignId,
        summary: `${input.kind} ${r.id.slice(0, 8)}`,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.crm_touch (org_id, campaign_id, customer_id, lead_id, opportunity_id, kind, touched_at, note, created_by)
        values (${ctx.orgId}, ${input.campaignId}, ${input.customerId ?? null}, ${input.leadId ?? null}, ${input.opportunityId ?? null},
                ${input.kind}, coalesce(${input.touchedAt ?? null}::timestamptz, now()), ${input.note ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export type AttributionModel = "first_touch" | "last_touch" | "linear";

export type AttributionRow = {
  campaignId: string;
  campaignName: string;
  model: AttributionModel;
  wonOpportunities: number;
  attributedMinor: number | null;
  costMinor: number;
  currency: string | null;
  /** Return per unit cost, or null when cost is zero or money is hidden. */
  returnRatio: number | null;
};

/** Pure: split each won opportunity's value across its ordered campaign touches under one model. */
export function attribute(
  model: AttributionModel,
  won: Array<{
    opportunityId: string;
    valueMinor: number;
    touches: Array<{ campaignId: string; at: string }>;
  }>,
): Map<string, { won: number; minor: number }> {
  const out = new Map<string, { won: number; minor: number }>();
  const add = (c: string, minor: number, wonInc: number) => {
    const cur = out.get(c) ?? { won: 0, minor: 0 };
    out.set(c, { won: cur.won + wonInc, minor: cur.minor + minor });
  };
  for (const o of won) {
    const ts = [...o.touches].sort((a, b) => a.at.localeCompare(b.at));
    if (ts.length === 0) continue;
    if (model === "first_touch") add(ts[0]!.campaignId, o.valueMinor, 1);
    else if (model === "last_touch") add(ts[ts.length - 1]!.campaignId, o.valueMinor, 1);
    else {
      const share = Math.floor(o.valueMinor / ts.length);
      const uniq = new Set<string>();
      for (const t of ts) {
        add(t.campaignId, share, uniq.has(t.campaignId) ? 0 : 1);
        uniq.add(t.campaignId);
      }
    }
  }
  return out;
}

export async function attributionReport(
  ctx: Ctx,
  archetype: RoleArchetype,
  model: AttributionModel,
  range?: { from?: string; to?: string },
): Promise<AttributionRow[]> {
  assertCan(archetype, "crm.forecast.view");
  return withCtx(ctx, async (tx) => {
    const won = (await tx.execute(sql`
      select o.id::text as id, coalesce(o.estimated_value_minor, 0)::bigint as value_minor,
             coalesce(json_agg(json_build_object('campaignId', t.campaign_id::text, 'at', t.touched_at::text) order by t.touched_at)
                      filter (where t.id is not null), '[]'::json) as touches
      from public.opportunity o
      left join public.crm_touch t on t.org_id = o.org_id and (t.opportunity_id = o.id or (o.lead_id is not null and t.lead_id = o.lead_id) or (o.customer_id is not null and t.customer_id = o.customer_id))
      where o.org_id = ${ctx.orgId} and o.status = 'won'
        and (${range?.from ?? null}::date is null or o.won_at >= ${range?.from ?? null}::date)
        and (${range?.to ?? null}::date is null or o.won_at < (${range?.to ?? null}::date + 1))
      group by o.id
    `)) as unknown as Array<{
      id: string;
      value_minor: number;
      touches: Array<{ campaignId: string; at: string }>;
    }>;
    // The campaign the opportunity or its lead was created under counts as a touch too.
    const direct = (await tx.execute(sql`
      select o.id::text as id, coalesce(o.campaign_id, l.campaign_id)::text as campaign_id, coalesce(l.created_at, o.created_at)::text as at
      from public.opportunity o left join public.lead l on l.id = o.lead_id
      where o.org_id = ${ctx.orgId} and o.status = 'won' and coalesce(o.campaign_id, l.campaign_id) is not null
    `)) as unknown as Array<{ id: string; campaign_id: string; at: string }>;
    const byId = new Map(
      won.map((w) => [
        w.id,
        { opportunityId: w.id, valueMinor: Number(w.value_minor), touches: [...w.touches] },
      ]),
    );
    for (const d of direct) {
      const w = byId.get(d.id);
      if (w && !w.touches.some((t) => t.campaignId === d.campaign_id))
        w.touches.push({ campaignId: d.campaign_id, at: d.at });
    }
    const split = attribute(model, [...byId.values()]);
    const campaigns = (await tx.execute(sql`
      select id::text as id, name, cost_minor, currency from public.crm_campaign where org_id = ${ctx.orgId} order by created_at desc limit 300
    `)) as unknown as Array<{
      id: string;
      name: string;
      cost_minor: number;
      currency: string | null;
    }>;
    return campaigns.map((c) => {
      const s = split.get(c.id) ?? { won: 0, minor: 0 };
      const cost = Number(c.cost_minor);
      return {
        campaignId: c.id,
        campaignName: c.name,
        model,
        wonOpportunities: s.won,
        attributedMinor: ctx.pricePrivileged ? s.minor : null,
        costMinor: cost,
        currency: c.currency,
        returnRatio:
          ctx.pricePrivileged && cost > 0 ? Math.round((s.minor / cost) * 100) / 100 : null,
      };
    });
  });
}
