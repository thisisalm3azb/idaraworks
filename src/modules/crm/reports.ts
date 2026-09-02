/**
 * H27 — revenue reports. Every figure is an aggregate computed in the
 * database across the FULL filtered result (never a page, never the first
 * 1,000 rows); each report names what it counted.
 */
import { z } from "zod";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const ReportRange = z.object({
  from: isoDate.optional().nullable(),
  to: isoDate.optional().nullable(),
});
export type ReportRange = z.infer<typeof ReportRange>;

export type FunnelReport = {
  range: { from: string | null; to: string | null };
  leads: {
    total: number;
    byStatus: Record<string, number>;
    bySource: Record<string, number>;
    quarantined: number;
  };
  opportunities: {
    created: number;
    byStage: Array<{ stageKey: string; count: number; valueMinor: number | null }>;
    won: { count: number; valueMinor: number | null };
    lost: { count: number };
    open: number;
  };
  conversion: { leadToOpportunityPct: number | null; opportunityToWonPct: number | null };
  basis: string;
};

function rangeWhere(col: ReturnType<typeof sql>, r: ReportRange) {
  return sql`(${r.from ?? null}::date is null or ${col} >= ${r.from ?? null}::date)
    and (${r.to ?? null}::date is null or ${col} < (${r.to ?? null}::date + 1))`;
}

export async function funnelReport(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<FunnelReport> {
  assertCan(archetype, "crm.forecast.view");
  const r = ReportRange.parse(raw ?? {});
  const seesPrice = ctx.pricePrivileged;
  return withCtx(ctx, async (tx) => {
    const leads = (await tx.execute(sql`
      select status, source_kind, quarantine, count(*)::int as n from public.lead
      where org_id = ${ctx.orgId} and archived = false and ${rangeWhere(sql`created_at`, r)}
      group by 1, 2, 3
    `)) as unknown as Array<{ status: string; source_kind: string; quarantine: string; n: number }>;
    const byStatus: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let total = 0;
    let quarantined = 0;
    for (const l of leads) {
      total += l.n;
      byStatus[l.status] = (byStatus[l.status] ?? 0) + l.n;
      bySource[l.source_kind] = (bySource[l.source_kind] ?? 0) + l.n;
      if (l.quarantine === "quarantined") quarantined += l.n;
    }
    const opps = (await tx.execute(sql`
      select stage_key, status, count(*)::int as n, sum(coalesce(estimated_value_minor, 0))::bigint as v
      from public.opportunity
      where org_id = ${ctx.orgId} and archived = false and ${rangeWhere(sql`created_at`, r)}
      group by 1, 2
    `)) as unknown as Array<{ stage_key: string; status: string; n: number; v: string }>;
    const byStage = new Map<string, { count: number; valueMinor: number }>();
    let created = 0;
    let won = { count: 0, valueMinor: 0 };
    let lost = 0;
    let open = 0;
    for (const o of opps) {
      created += o.n;
      const cur = byStage.get(o.stage_key) ?? { count: 0, valueMinor: 0 };
      cur.count += o.n;
      cur.valueMinor += Number(o.v);
      byStage.set(o.stage_key, cur);
      if (o.status === "won")
        won = { count: won.count + o.n, valueMinor: won.valueMinor + Number(o.v) };
      else if (o.status === "lost") lost += o.n;
      else open += o.n;
    }
    return {
      range: { from: r.from ?? null, to: r.to ?? null },
      leads: { total, byStatus, bySource, quarantined },
      opportunities: {
        created,
        byStage: [...byStage.entries()].map(([stageKey, s]) => ({
          stageKey,
          count: s.count,
          valueMinor: seesPrice ? s.valueMinor : null,
        })),
        won: { count: won.count, valueMinor: seesPrice ? won.valueMinor : null },
        lost: { count: lost },
        open,
      },
      conversion: {
        leadToOpportunityPct: total > 0 ? Math.round((created / total) * 1000) / 10 : null,
        opportunityToWonPct: created > 0 ? Math.round((won.count / created) * 1000) / 10 : null,
      },
      basis:
        "Leads and opportunities created in the range (creation date), grouped by their current status and stage.",
    };
  });
}

export type ActivityReport = {
  range: { from: string | null; to: string | null };
  total: number;
  byKind: Array<{ kind: string; count: number; completed: number }>;
  byOwner: Array<{
    ownerUserId: string | null;
    ownerName: string | null;
    count: number;
    completed: number;
  }>;
  byOutcome: Array<{ outcome: string; count: number }>;
  basis: string;
};

/** Counts of logged commercial activity. By-owner rows are shown only to forecast viewers (managers), never as surveillance of individuals' time. */
export async function activityReport(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<ActivityReport> {
  assertCan(archetype, "crm.forecast.view");
  const r = ReportRange.parse(raw ?? {});
  return withCtx(ctx, async (tx) => {
    const kinds = (await tx.execute(sql`
      select kind, count(*)::int as n, count(completed_at)::int as done from public.sales_activity
      where org_id = ${ctx.orgId} and ${rangeWhere(sql`created_at`, r)} group by 1 order by 2 desc
    `)) as unknown as Array<{ kind: string; n: number; done: number }>;
    const owners = (await tx.execute(sql`
      select a.owner_user_id::text as owner, u.full_name as name, count(*)::int as n, count(a.completed_at)::int as done
      from public.sales_activity a left join public.user_profile u on u.id = a.owner_user_id
      where a.org_id = ${ctx.orgId} and ${rangeWhere(sql`a.created_at`, r)} group by 1, 2 order by 3 desc limit 50
    `)) as unknown as Array<{ owner: string | null; name: string | null; n: number; done: number }>;
    const outcomes = (await tx.execute(sql`
      select outcome, count(*)::int as n from public.sales_activity
      where org_id = ${ctx.orgId} and outcome is not null and ${rangeWhere(sql`created_at`, r)} group by 1 order by 2 desc
    `)) as unknown as Array<{ outcome: string; n: number }>;
    return {
      range: { from: r.from ?? null, to: r.to ?? null },
      total: kinds.reduce((s, k) => s + k.n, 0),
      byKind: kinds.map((k) => ({ kind: k.kind, count: k.n, completed: k.done })),
      byOwner: owners.map((o) => ({
        ownerUserId: o.owner,
        ownerName: o.name,
        count: o.n,
        completed: o.done,
      })),
      byOutcome: outcomes.map((o) => ({ outcome: o.outcome, count: o.n })),
      basis:
        "Activities logged in the range (creation date), including automated tasks; completed = has a completion time.",
    };
  });
}

export type WinLossReport = {
  range: { from: string | null; to: string | null };
  won: { count: number; valueMinor: number | null; avgCycleDays: number | null };
  lost: { count: number; valueMinor: number | null; avgCycleDays: number | null };
  winRatePct: number | null;
  lossReasons: Array<{ reason: string; count: number }>;
  byOwner: Array<{
    ownerUserId: string | null;
    ownerName: string | null;
    won: number;
    lost: number;
  }>;
  byKind: Array<{ kind: string; won: number; lost: number }>;
  basis: string;
};

export async function winLossReport(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<WinLossReport> {
  assertCan(archetype, "crm.forecast.view");
  const r = ReportRange.parse(raw ?? {});
  const seesPrice = ctx.pricePrivileged;
  return withCtx(ctx, async (tx) => {
    const closedAt = sql`coalesce(o.won_at, o.lost_at)`;
    const totals = (await tx.execute(sql`
      select o.status, count(*)::int as n, sum(coalesce(o.estimated_value_minor, 0))::bigint as v,
             avg(extract(epoch from (${closedAt} - o.created_at)) / 86400)::float as cycle
      from public.opportunity o
      where o.org_id = ${ctx.orgId} and o.status in ('won', 'lost') and ${rangeWhere(closedAt, r)}
      group by 1
    `)) as unknown as Array<{ status: string; n: number; v: string; cycle: number | null }>;
    const pick = (s: string) => totals.find((x) => x.status === s);
    const w = pick("won");
    const l = pick("lost");
    const reasons = (await tx.execute(sql`
      select coalesce(o.loss_reason, 'unspecified') as reason, count(*)::int as n from public.opportunity o
      where o.org_id = ${ctx.orgId} and o.status = 'lost' and ${rangeWhere(sql`o.lost_at`, r)} group by 1 order by 2 desc
    `)) as unknown as Array<{ reason: string; n: number }>;
    const owners = (await tx.execute(sql`
      select o.owner_user_id::text as owner, u.full_name as name,
             count(*) filter (where o.status = 'won')::int as won, count(*) filter (where o.status = 'lost')::int as lost
      from public.opportunity o left join public.user_profile u on u.id = o.owner_user_id
      where o.org_id = ${ctx.orgId} and o.status in ('won', 'lost') and ${rangeWhere(closedAt, r)}
      group by 1, 2 order by 3 desc limit 50
    `)) as unknown as Array<{
      owner: string | null;
      name: string | null;
      won: number;
      lost: number;
    }>;
    const kinds = (await tx.execute(sql`
      select o.kind, count(*) filter (where o.status = 'won')::int as won, count(*) filter (where o.status = 'lost')::int as lost
      from public.opportunity o
      where o.org_id = ${ctx.orgId} and o.status in ('won', 'lost') and ${rangeWhere(closedAt, r)} group by 1
    `)) as unknown as Array<{ kind: string; won: number; lost: number }>;
    const wonN = w?.n ?? 0;
    const lostN = l?.n ?? 0;
    return {
      range: { from: r.from ?? null, to: r.to ?? null },
      won: {
        count: wonN,
        valueMinor: seesPrice ? Number(w?.v ?? 0) : null,
        avgCycleDays: w?.cycle ?? null,
      },
      lost: {
        count: lostN,
        valueMinor: seesPrice ? Number(l?.v ?? 0) : null,
        avgCycleDays: l?.cycle ?? null,
      },
      winRatePct: wonN + lostN > 0 ? Math.round((wonN / (wonN + lostN)) * 1000) / 10 : null,
      lossReasons: reasons.map((x) => ({ reason: x.reason, count: x.n })),
      byOwner: owners.map((o) => ({
        ownerUserId: o.owner,
        ownerName: o.name,
        won: o.won,
        lost: o.lost,
      })),
      byKind: kinds.map((k) => ({ kind: k.kind, won: k.won, lost: k.lost })),
      basis:
        "Opportunities closed (won or lost) in the range by their close date; cycle = days from creation to close.",
    };
  });
}
