/**
 * H27 — customer success overview: every active customer scored with the
 * same evidence-based health as the 360 (scoreHealth), paged from the
 * database, with renewals and at-risk counts computed across the FULL set.
 * Nothing is pretended: a fact the role cannot see is "unknown".
 */
import { z } from "zod";
import { assertCan, can } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { scoreHealth, type CustomerHealth } from "./customers";

export const SuccessQuery = z.object({
  band: z.enum(["healthy", "watch", "at_risk", "unknown", "all"]).default("all"),
  search: z.string().trim().max(200).optional(),
  ownerUserId: z.string().uuid().optional().nullable(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export type SuccessRow = {
  id: string;
  name: string;
  ownerName: string | null;
  segment: string | null;
  tags: string[];
  openOpportunities: number;
  overdueInvoices: number | null;
  openIssues: number | null;
  lastActivityAt: string | null;
  satisfaction: number | null;
  churnRisk: number | null;
  renewalsDue90: number;
  health: CustomerHealth;
};

export type SuccessOverview = {
  rows: SuccessRow[];
  total: number;
  /** Across the FULL filtered result. */
  counts: {
    atRisk: number;
    watch: number;
    healthy: number;
    unknown: number;
    renewalsDue90: number;
  };
};

type Fact = {
  id: string;
  name: string;
  owner_name: string | null;
  segment: string | null;
  tags: string[] | null;
  open_opps: number;
  overdue: number | null;
  open_issues: number | null;
  last_at: string | null;
  satisfaction: number | null;
  churn: number | null;
  renewals: number;
  stalled: number;
  overdue_obl: number | null;
};

function healthOf(
  f: Fact,
  seesInvoices: boolean,
  seesIssues: boolean,
  seesDocs: boolean,
): CustomerHealth {
  const daysSince = f.last_at
    ? Math.floor((Date.now() - new Date(f.last_at).getTime()) / 86_400_000)
    : null;
  return scoreHealth([
    {
      key: "invoices",
      label: "Overdue invoices",
      weight: 3,
      value: seesInvoices && f.overdue !== null ? (f.overdue > 0 ? -1 : 1) : null,
      evidence: seesInvoices ? `${f.overdue ?? 0} overdue` : "not visible to this role",
    },
    {
      key: "issues",
      label: "Open issues",
      weight: 2,
      value: seesIssues && f.open_issues !== null ? (f.open_issues > 0 ? -0.5 : 1) : null,
      evidence: `${f.open_issues ?? 0} open`,
    },
    {
      key: "stalled",
      label: "Stalled opportunities",
      weight: 1,
      value: f.stalled > 0 ? -0.5 : 0.5,
      evidence: `${f.stalled} open with no activity for 30 days`,
    },
    {
      key: "obligations",
      label: "Overdue obligations",
      weight: 2,
      value: seesDocs && f.overdue_obl !== null ? (f.overdue_obl > 0 ? -1 : 1) : null,
      evidence: `${f.overdue_obl ?? 0} overdue`,
    },
    {
      key: "engagement",
      label: "Recent engagement",
      weight: 2,
      value: daysSince === null ? null : daysSince <= 30 ? 1 : daysSince <= 90 ? 0 : -1,
      evidence:
        daysSince === null ? "no activity recorded" : `${daysSince} days since last activity`,
    },
    {
      key: "satisfaction",
      label: "Satisfaction",
      weight: 3,
      value: f.satisfaction === null ? null : (f.satisfaction - 3) / 2,
      evidence: f.satisfaction === null ? "no satisfaction record" : `${f.satisfaction}/5`,
    },
    {
      key: "churn",
      label: "Churn risk record",
      weight: 2,
      value: f.churn === null ? null : 1 - (f.churn / 100) * 2,
      evidence: f.churn === null ? "no churn-risk record" : `${f.churn}/100`,
    },
  ]);
}

export async function successOverview(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<SuccessOverview> {
  assertCan(archetype, "customers.view");
  const q = SuccessQuery.parse(raw ?? {});
  const seesInvoices = can(archetype, "invoices.view");
  const seesIssues = can(archetype, "issues.raise");
  const seesDocs = can(archetype, "documents.view");
  const search = q.search ? `%${q.search}%` : null;
  return withCtx(ctx, async (tx) => {
    // One row per customer with the facts the score needs; bands are computed
    // in code, so the band filter pages over the scored set (bounded by the
    // organisation's customer count, which is a master table by design).
    const rows = (await tx.execute(sql`
      select c.id::text as id, c.name, u.full_name as owner_name, c.segment, c.tags,
             (select count(*)::int from public.opportunity o where o.org_id = c.org_id and o.customer_id = c.id and o.status = 'open' and o.archived = false) as open_opps,
             ${seesInvoices ? sql`(select count(*)::int from public.invoice i where i.org_id = c.org_id and i.customer_id = c.id and i.status in ('issued','partially_paid') and i.due_date < current_date)` : sql`null::int`} as overdue,
             ${seesIssues ? sql`(select count(*)::int from public.issue i join public.job j on j.id = i.job_id and j.org_id = i.org_id where i.org_id = c.org_id and j.customer_id = c.id and i.status not in ('closed','resolved','done'))` : sql`null::int`} as open_issues,
             (select max(a.created_at)::text from public.sales_activity a where a.org_id = c.org_id and (a.customer_id = c.id or a.opportunity_id in (select id from public.opportunity where org_id = c.org_id and customer_id = c.id))) as last_at,
             (select s.score from public.crm_customer_signal s where s.org_id = c.org_id and s.customer_id = c.id and s.kind = 'satisfaction' order by s.recorded_at desc limit 1) as satisfaction,
             (select s.score from public.crm_customer_signal s where s.org_id = c.org_id and s.customer_id = c.id and s.kind = 'churn_risk' order by s.recorded_at desc limit 1) as churn,
             ${seesDocs ? sql`(select count(*)::int from public.doc_obligation ob join public.doc_document d on d.id = ob.document_id and d.org_id = ob.org_id where ob.org_id = c.org_id and d.counterparty_kind = 'customer' and d.counterparty_id = c.id and ob.kind = 'renewal' and ob.status = 'open' and ob.due_on <= current_date + 90)` : sql`0::int`} as renewals,
             (select count(*)::int from public.opportunity o where o.org_id = c.org_id and o.customer_id = c.id and o.status = 'open' and o.archived = false and coalesce(o.last_activity_at, o.stage_entered_at) < now() - interval '30 days') as stalled,
             ${seesDocs ? sql`(select count(*)::int from public.doc_obligation ob join public.doc_document d on d.id = ob.document_id and d.org_id = ob.org_id where ob.org_id = c.org_id and d.counterparty_kind = 'customer' and d.counterparty_id = c.id and ob.status = 'open' and ob.due_on < current_date)` : sql`null::int`} as overdue_obl
      from public.customer c left join public.user_profile u on u.id = c.owner_user_id
      where c.org_id = ${ctx.orgId} and c.active = true and c.merged_into_customer_id is null
        and (${search}::text is null or c.name ilike ${search})
        and (${q.ownerUserId ?? null}::uuid is null or c.owner_user_id = ${q.ownerUserId ?? null}::uuid)
      order by c.name
    `)) as unknown as Fact[];
    const scored = rows.map((f) => ({
      id: f.id,
      name: f.name,
      ownerName: f.owner_name,
      segment: f.segment,
      tags: f.tags ?? [],
      openOpportunities: Number(f.open_opps),
      overdueInvoices: f.overdue === null ? null : Number(f.overdue),
      openIssues: f.open_issues === null ? null : Number(f.open_issues),
      lastActivityAt: f.last_at,
      satisfaction: f.satisfaction === null ? null : Number(f.satisfaction),
      churnRisk: f.churn === null ? null : Number(f.churn),
      renewalsDue90: Number(f.renewals),
      health: healthOf(f, seesInvoices, seesIssues, seesDocs),
    }));
    const counts = {
      atRisk: scored.filter((r) => r.health.band === "at_risk").length,
      watch: scored.filter((r) => r.health.band === "watch").length,
      healthy: scored.filter((r) => r.health.band === "healthy").length,
      unknown: scored.filter((r) => r.health.band === "unknown").length,
      renewalsDue90: scored.reduce((s, r) => s + r.renewalsDue90, 0),
    };
    const order = { at_risk: 0, watch: 1, unknown: 2, healthy: 3 } as const;
    const filtered = (
      q.band === "all" ? scored : scored.filter((r) => r.health.band === q.band)
    ).sort((a, b) => order[a.health.band] - order[b.health.band] || a.name.localeCompare(b.name));
    return { rows: filtered.slice(q.offset, q.offset + q.limit), total: filtered.length, counts };
  });
}
