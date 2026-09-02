/**
 * H27 — forecasting and revenue intelligence (ADR-38, ADR-45).
 *
 * Every number is deterministic, computed in SQL over the FULL filtered set,
 * and carries the model that produced it. Weighted value = value × the
 * opportunity's own probability, else the stage default, else 0. Categories
 * (commit, best_case, pipeline, omitted) are the person's call, recorded when
 * changed. Snapshots freeze a period's numbers so prediction can be compared
 * with outcome. Scenarios are overlays computed in `applyOverlay` (pure) and
 * never touch live opportunities until a reviewed apply.
 */
import { z } from "zod";
import { command } from "@/platform/audit";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import { moveStage } from "./pipelines";
import { updateCommercial } from "./dealroom";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export type ForecastRow = {
  id: string;
  name: string;
  customerName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  territoryId: string | null;
  campaignId: string | null;
  source: string | null;
  kind: "new_business" | "expansion" | "renewal";
  stageKey: string;
  category: "pipeline" | "best_case" | "commit" | "omitted";
  valueMinor: number;
  probability: number;
  probabilitySource: "opportunity" | "stage" | "none";
  weightedMinor: number;
  expectedCloseDate: string | null;
  stageAgeDays: number;
  createdAt: string;
};

export type ForecastBucket = {
  key: string;
  count: number;
  valueMinor: number;
  weightedMinor: number;
};

export type Forecast = {
  currency: string;
  model: {
    weighted: "value × probability (opportunity, else stage default)";
    coverage: "pipeline ÷ target";
    velocity: "count × avg value × win rate ÷ avg cycle days";
  };
  rows: ForecastRow[];
  totals: {
    count: number;
    pipelineMinor: number;
    weightedMinor: number;
    commitMinor: number;
    bestCaseMinor: number;
    omittedMinor: number;
  };
  byPeriod: { week: ForecastBucket[]; month: ForecastBucket[]; quarter: ForecastBucket[] };
  byOwner: ForecastBucket[];
  byTerritory: ForecastBucket[];
  bySource: ForecastBucket[];
  byKind: ForecastBucket[];
  byStage: Array<ForecastBucket & { avgAgeDays: number }>;
  conversion: {
    won: number;
    lost: number;
    winRate: number | null;
    avgCycleDays: number | null;
    avgWonMinor: number | null;
    velocityMinorPerDay: number | null;
  };
  stalled: ForecastRow[];
  redacted: boolean;
};

export const ForecastQuery = z.object({
  pipelineId: uuid.optional().nullable(),
  ownerUserId: uuid.optional().nullable(),
  territoryId: uuid.optional().nullable(),
  campaignId: uuid.optional().nullable(),
  kind: z.enum(["new_business", "expansion", "renewal"]).optional().nullable(),
  from: isoDate.optional().nullable(),
  to: isoDate.optional().nullable(),
  stalledDays: z.number().int().min(1).max(365).default(30),
  /** Won/lost window for conversion and velocity (days back). */
  historyDays: z.number().int().min(30).max(730).default(180),
});
export type ForecastQuery = z.infer<typeof ForecastQuery>;

function bucket(rows: ForecastRow[], keyOf: (r: ForecastRow) => string): ForecastBucket[] {
  const m = new Map<string, ForecastBucket>();
  for (const r of rows) {
    const k = keyOf(r);
    const b = m.get(k) ?? { key: k, count: 0, valueMinor: 0, weightedMinor: 0 };
    b.count++;
    b.valueMinor += r.valueMinor;
    b.weightedMinor += r.weightedMinor;
    m.set(k, b);
  }
  return [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d.getTime() - start.getTime()) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
export function quarterOf(date: string): string {
  return `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
}

export async function computeForecast(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<Forecast> {
  assertCan(archetype, "crm.forecast.view");
  const q = ForecastQuery.parse(raw ?? {});
  const redacted = !ctx.pricePrivileged;
  return withCtx(ctx, async (tx) => {
    const org = (await tx.execute(
      sql`select base_currency from public.org where id = ${ctx.orgId}`,
    )) as unknown as Array<{ base_currency: string }>;
    const currency = org[0]?.base_currency ?? "AED";
    const rows = (await tx.execute(sql`
      select o.id::text as id, o.name, c.name as customer_name, o.owner_user_id::text as owner_user_id, u.full_name as owner_name,
             o.territory_id::text as territory_id, o.campaign_id::text as campaign_id, o.source, o.kind, o.stage_key, o.forecast_category,
             coalesce(o.estimated_value_minor, 0)::bigint as value_minor, o.probability, s.default_probability,
             o.expected_close_date::text as close_date, greatest(0, extract(day from now() - o.stage_entered_at))::int as age,
             coalesce(o.last_activity_at, o.stage_entered_at) < now() - make_interval(days => ${q.stalledDays}) as stalled,
             o.created_at::text as created_at
      from public.opportunity o
      left join public.customer c on c.id = o.customer_id
      left join public.user_profile u on u.id = o.owner_user_id
      left join public.pipeline_stage s on s.org_id = o.org_id and s.key = o.stage_key
      where o.org_id = ${ctx.orgId} and o.status = 'open' and o.archived = false
        and (${q.pipelineId ?? null}::uuid is null or o.pipeline_id = ${q.pipelineId ?? null}::uuid)
        and (${q.ownerUserId ?? null}::uuid is null or o.owner_user_id = ${q.ownerUserId ?? null}::uuid)
        and (${q.territoryId ?? null}::uuid is null or o.territory_id = ${q.territoryId ?? null}::uuid)
        and (${q.campaignId ?? null}::uuid is null or o.campaign_id = ${q.campaignId ?? null}::uuid)
        and (${q.kind ?? null}::text is null or o.kind = ${q.kind ?? null})
        and (${q.from ?? null}::date is null or o.expected_close_date >= ${q.from ?? null}::date)
        and (${q.to ?? null}::date is null or o.expected_close_date <= ${q.to ?? null}::date)
      order by o.expected_close_date asc nulls last
      limit 5000
    `)) as unknown as Array<Record<string, unknown>>;
    const stalledRows: ForecastRow[] = [];
    const list: ForecastRow[] = rows.map((r) => {
      const own = r.probability === null ? null : Number(r.probability);
      const stage = r.default_probability === null ? null : Number(r.default_probability);
      const probability = own ?? stage ?? 0;
      const value = redacted ? 0 : Number(r.value_minor);
      const row: ForecastRow = {
        id: String(r.id),
        name: String(r.name),
        customerName: (r.customer_name as string | null) ?? null,
        ownerUserId: (r.owner_user_id as string | null) ?? null,
        ownerName: (r.owner_name as string | null) ?? null,
        territoryId: (r.territory_id as string | null) ?? null,
        campaignId: (r.campaign_id as string | null) ?? null,
        source: (r.source as string | null) ?? null,
        kind: String(r.kind) as ForecastRow["kind"],
        stageKey: String(r.stage_key),
        category: String(r.forecast_category) as ForecastRow["category"],
        valueMinor: value,
        probability,
        probabilitySource: own !== null ? "opportunity" : stage !== null ? "stage" : "none",
        weightedMinor: Math.round((value * probability) / 100),
        expectedCloseDate: (r.close_date as string | null) ?? null,
        stageAgeDays: Number(r.age),
        createdAt: String(r.created_at),
      };
      if (r.stalled) stalledRows.push(row);
      return row;
    });
    const active = list.filter((r) => r.category !== "omitted");
    const sum = (rs: ForecastRow[], f: (r: ForecastRow) => number) =>
      rs.reduce((s, r) => s + f(r), 0);
    const hist = (await tx.execute(sql`
      select status, count(*)::int as n, coalesce(avg(estimated_value_minor), 0)::bigint as avg_minor,
             coalesce(avg(extract(epoch from (coalesce(won_at, lost_at) - created_at)) / 86400), 0)::int as cycle_days
      from public.opportunity
      where org_id = ${ctx.orgId} and status in ('won', 'lost') and coalesce(won_at, lost_at) >= now() - make_interval(days => ${q.historyDays})
      group by status
    `)) as unknown as Array<{ status: string; n: number; avg_minor: number; cycle_days: number }>;
    const won = hist.find((h) => h.status === "won");
    const lost = hist.find((h) => h.status === "lost");
    const wonN = Number(won?.n ?? 0);
    const lostN = Number(lost?.n ?? 0);
    const winRate = wonN + lostN > 0 ? Math.round((wonN / (wonN + lostN)) * 100) / 100 : null;
    const avgCycle = won ? Number(won.cycle_days) : null;
    const avgWon = won && !redacted ? Number(won.avg_minor) : null;
    const velocity =
      winRate !== null && avgCycle && avgCycle > 0 && avgWon !== null
        ? Math.round((active.length * avgWon * winRate) / avgCycle)
        : null;
    const byStageRaw = bucket(active, (r) => r.stageKey);
    return {
      currency,
      model: {
        weighted: "value × probability (opportunity, else stage default)",
        coverage: "pipeline ÷ target",
        velocity: "count × avg value × win rate ÷ avg cycle days",
      },
      rows: list,
      totals: {
        count: active.length,
        pipelineMinor: sum(active, (r) => r.valueMinor),
        weightedMinor: sum(active, (r) => r.weightedMinor),
        commitMinor: sum(
          active.filter((r) => r.category === "commit"),
          (r) => r.valueMinor,
        ),
        bestCaseMinor: sum(
          active.filter((r) => r.category === "best_case" || r.category === "commit"),
          (r) => r.valueMinor,
        ),
        omittedMinor: sum(
          list.filter((r) => r.category === "omitted"),
          (r) => r.valueMinor,
        ),
      },
      byPeriod: {
        week: bucket(active, (r) =>
          r.expectedCloseDate ? isoWeek(r.expectedCloseDate) : "unscheduled",
        ),
        month: bucket(active, (r) => r.expectedCloseDate?.slice(0, 7) ?? "unscheduled"),
        quarter: bucket(active, (r) =>
          r.expectedCloseDate ? quarterOf(r.expectedCloseDate) : "unscheduled",
        ),
      },
      byOwner: bucket(active, (r) => r.ownerName ?? "unassigned"),
      byTerritory: bucket(active, (r) => r.territoryId ?? "none"),
      bySource: bucket(active, (r) => r.source ?? "unknown"),
      byKind: bucket(active, (r) => r.kind),
      byStage: byStageRaw.map((b) => ({
        ...b,
        avgAgeDays: Math.round(
          active.filter((r) => r.stageKey === b.key).reduce((s, r) => s + r.stageAgeDays, 0) /
            Math.max(1, b.count),
        ),
      })),
      conversion: {
        won: wonN,
        lost: lostN,
        winRate,
        avgCycleDays: avgCycle,
        avgWonMinor: avgWon,
        velocityMinorPerDay: velocity,
      },
      stalled: stalledRows,
      redacted,
    };
  });
}

// ── snapshots and accuracy ────────────────────────────────────────────────────
export async function captureForecastSnapshot(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string; periodKey: string }> {
  assertCan(archetype, "crm.forecast.view");
  const input = z
    .object({
      periodKey: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$/),
      note: z.string().max(500).optional().nullable(),
      pipelineId: uuid.optional().nullable(),
    })
    .parse(raw);
  const f = await computeForecast(ctx, archetype, { pipelineId: input.pipelineId ?? null });
  if (f.redacted) throw new Error("a snapshot needs price visibility");
  const inPeriod = f.rows.filter((r) => {
    if (!r.expectedCloseDate) return false;
    return input.periodKey.includes("Q")
      ? quarterOf(r.expectedCloseDate) === input.periodKey
      : r.expectedCloseDate.slice(0, 7) === input.periodKey;
  });
  const totals = {
    count: inPeriod.filter((r) => r.category !== "omitted").length,
    pipelineMinor: inPeriod
      .filter((r) => r.category !== "omitted")
      .reduce((s, r) => s + r.valueMinor, 0),
    weightedMinor: inPeriod
      .filter((r) => r.category !== "omitted")
      .reduce((s, r) => s + r.weightedMinor, 0),
    commitMinor: inPeriod
      .filter((r) => r.category === "commit")
      .reduce((s, r) => s + r.valueMinor, 0),
    bestCaseMinor: inPeriod
      .filter((r) => r.category === "commit" || r.category === "best_case")
      .reduce((s, r) => s + r.valueMinor, 0),
    model: f.model.weighted,
  };
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "crm.forecast.snapshot",
        entityType: "crm_forecast_snapshot",
        entityId: r.id,
        summary: input.periodKey,
      }),
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        insert into public.crm_forecast_snapshot (org_id, period_key, scope_kind, scope_id, captured_by, currency, totals, rows, row_count, note)
        values (${ctx.orgId}, ${input.periodKey}, ${input.pipelineId ? "pipeline" : "org"}, ${input.pipelineId ?? null}, ${ctx.userId}, ${f.currency},
                ${JSON.stringify(totals)}::jsonb,
                ${JSON.stringify(inPeriod.slice(0, 2000).map((r) => ({ id: r.id, stageKey: r.stageKey, category: r.category, valueMinor: r.valueMinor, probability: r.probability, weightedMinor: r.weightedMinor, closeDate: r.expectedCloseDate, ownerId: r.ownerUserId })))}::jsonb,
                ${inPeriod.length}, ${input.note ?? null})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id, periodKey: input.periodKey };
    },
  );
}

export type SnapshotAccuracy = {
  id: string;
  periodKey: string;
  capturedAt: string;
  capturedBy: string | null;
  predicted: {
    pipelineMinor: number;
    weightedMinor: number;
    commitMinor: number;
    bestCaseMinor: number;
    count: number;
  };
  actual: { wonMinor: number; wonCount: number; lostCount: number; stillOpen: number };
  /** weighted − won, as a share of predicted weighted (null when nothing predicted) */
  weightedErrorPct: number | null;
  commitHitPct: number | null;
};

/** Compare each snapshot with what happened to the opportunities it listed. */
export async function forecastAccuracy(
  ctx: Ctx,
  archetype: RoleArchetype,
  limit = 24,
): Promise<SnapshotAccuracy[]> {
  assertCan(archetype, "crm.forecast.view");
  return withCtx(ctx, async (tx) => {
    const snaps = (await tx.execute(sql`
      select s.id::text as id, s.period_key, s.captured_at::text as captured_at, u.full_name as captured_by, s.totals, s.rows
      from public.crm_forecast_snapshot s left join public.user_profile u on u.id = s.captured_by
      where s.org_id = ${ctx.orgId} order by s.captured_at desc limit ${Math.min(Math.max(limit, 1), 100)}
    `)) as unknown as Array<{
      id: string;
      period_key: string;
      captured_at: string;
      captured_by: string | null;
      totals: Record<string, number>;
      rows: Array<{ id: string; valueMinor: number; category: string }>;
    }>;
    const out: SnapshotAccuracy[] = [];
    for (const s of snaps) {
      const ids = s.rows.map((r) => r.id);
      const outcome = ids.length
        ? ((await tx.execute(sql`
            select id::text as id, status, coalesce(estimated_value_minor, 0)::bigint as value_minor from public.opportunity
            where org_id = ${ctx.orgId} and id in (select x::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) as x)
          `)) as unknown as Array<{ id: string; status: string; value_minor: number }>)
        : [];
      const won = outcome.filter((o) => o.status === "won");
      const wonMinor = ctx.pricePrivileged ? won.reduce((t, o) => t + Number(o.value_minor), 0) : 0;
      const predictedWeighted = Number(s.totals.weightedMinor ?? 0);
      const commitIds = new Set(s.rows.filter((r) => r.category === "commit").map((r) => r.id));
      const commitWon = won.filter((o) => commitIds.has(o.id)).length;
      out.push({
        id: s.id,
        periodKey: s.period_key,
        capturedAt: s.captured_at,
        capturedBy: s.captured_by,
        predicted: {
          pipelineMinor: ctx.pricePrivileged ? Number(s.totals.pipelineMinor ?? 0) : 0,
          weightedMinor: ctx.pricePrivileged ? predictedWeighted : 0,
          commitMinor: ctx.pricePrivileged ? Number(s.totals.commitMinor ?? 0) : 0,
          bestCaseMinor: ctx.pricePrivileged ? Number(s.totals.bestCaseMinor ?? 0) : 0,
          count: Number(s.totals.count ?? 0),
        },
        actual: {
          wonMinor,
          wonCount: won.length,
          lostCount: outcome.filter((o) => o.status === "lost").length,
          stillOpen: outcome.filter((o) => o.status === "open").length,
        },
        weightedErrorPct:
          ctx.pricePrivileged && predictedWeighted > 0
            ? Math.round(((predictedWeighted - wonMinor) / predictedWeighted) * 100)
            : null,
        commitHitPct: commitIds.size > 0 ? Math.round((commitWon / commitIds.size) * 100) : null,
      });
    }
    return out;
  });
}

// ── scenarios (overlays) ──────────────────────────────────────────────────────
export const Overlay = z.object({
  slips: z
    .array(z.object({ opportunityId: uuid, months: z.number().int().min(-12).max(24) }))
    .max(200)
    .default([]),
  excludes: z.array(uuid).max(200).default([]),
  probabilities: z
    .array(z.object({ opportunityId: uuid, probability: z.number().int().min(0).max(100) }))
    .max(200)
    .default([]),
  categories: z
    .array(
      z.object({
        opportunityId: uuid,
        category: z.enum(["pipeline", "best_case", "commit", "omitted"]),
      }),
    )
    .max(200)
    .default([]),
});
export type Overlay = z.infer<typeof Overlay>;

function addMonths(date: string, months: number): string {
  // Clamp to the last day of the target month (31 Jan + 1 month = 28/29 Feb).
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 + months;
  const day = Number(date.slice(8, 10));
  const first = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last)));
  return d.toISOString().slice(0, 10);
}

/** Pure: the forecast rows with the overlay applied; live rows untouched. */
export function applyOverlay(rows: ForecastRow[], overlay: Overlay): ForecastRow[] {
  const ex = new Set(overlay.excludes);
  const slip = new Map(overlay.slips.map((s) => [s.opportunityId, s.months]));
  const prob = new Map(overlay.probabilities.map((p) => [p.opportunityId, p.probability]));
  const cat = new Map(overlay.categories.map((c) => [c.opportunityId, c.category]));
  return rows
    .filter((r) => !ex.has(r.id))
    .map((r) => {
      const p = prob.get(r.id) ?? r.probability;
      const m = slip.get(r.id);
      return {
        ...r,
        probability: p,
        probabilitySource: prob.has(r.id) ? "opportunity" : r.probabilitySource,
        weightedMinor: Math.round((r.valueMinor * p) / 100),
        expectedCloseDate:
          m && r.expectedCloseDate ? addMonths(r.expectedCloseDate, m) : r.expectedCloseDate,
        category: cat.get(r.id) ?? r.category,
      };
    });
}

export function summarise(rows: ForecastRow[]): {
  count: number;
  pipelineMinor: number;
  weightedMinor: number;
  commitMinor: number;
  month: ForecastBucket[];
} {
  const active = rows.filter((r) => r.category !== "omitted");
  return {
    count: active.length,
    pipelineMinor: active.reduce((s, r) => s + r.valueMinor, 0),
    weightedMinor: active.reduce((s, r) => s + r.weightedMinor, 0),
    commitMinor: active
      .filter((r) => r.category === "commit")
      .reduce((s, r) => s + r.valueMinor, 0),
    month: bucket(active, (r) => r.expectedCloseDate?.slice(0, 7) ?? "unscheduled"),
  };
}

export async function saveScenario(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ id: string }> {
  assertCan(archetype, "crm.forecast.view");
  const input = z
    .object({
      id: uuid.optional(),
      name: z.string().trim().min(1).max(120),
      overlay: Overlay,
      assumptions: z.string().trim().max(2000).optional().nullable(),
    })
    .parse(raw);
  return command(
    ctx,
    {
      audit: (r: { id: string }) => ({
        action: "crm.scenario.save",
        entityType: "crm_scenario",
        entityId: r.id,
        summary: input.name,
      }),
    },
    async (tx) => {
      if (input.id) {
        const rows = (await tx.execute(sql`
          update public.crm_scenario set name = ${input.name}, overlay = ${JSON.stringify(input.overlay)}::jsonb, assumptions = ${input.assumptions ?? null}
          where id = ${input.id} and org_id = ${ctx.orgId} and status in ('draft', 'reviewed') returning id::text as id
        `)) as unknown as Array<{ id: string }>;
        if (!rows[0]) throw new Error("scenario not editable");
        return { id: rows[0].id };
      }
      const rows = (await tx.execute(sql`
        insert into public.crm_scenario (org_id, name, overlay, assumptions, created_by)
        values (${ctx.orgId}, ${input.name}, ${JSON.stringify(input.overlay)}::jsonb, ${input.assumptions ?? null}, ${ctx.userId})
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      return { id: rows[0]!.id };
    },
  );
}

export type ScenarioRow = {
  id: string;
  name: string;
  overlay: Overlay;
  assumptions: string | null;
  status: string;
  createdBy: string;
  createdAt: string;
  appliedAt: string | null;
};

export async function listScenarios(ctx: Ctx, archetype: RoleArchetype): Promise<ScenarioRow[]> {
  assertCan(archetype, "crm.forecast.view");
  const rows = (await withCtx(ctx, (tx) =>
    tx.execute(sql`
      select s.id::text as id, s.name, s.overlay, s.assumptions, s.status, u.full_name as created_by, s.created_at::text as created_at, s.applied_at::text as applied_at
      from public.crm_scenario s left join public.user_profile u on u.id = s.created_by
      where s.org_id = ${ctx.orgId} order by s.created_at desc limit 100
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    overlay: Overlay.parse(r.overlay ?? {}),
    assumptions: (r.assumptions as string | null) ?? null,
    status: String(r.status),
    createdBy: String(r.created_by ?? ""),
    createdAt: String(r.created_at),
    appliedAt: (r.applied_at as string | null) ?? null,
  }));
}

/**
 * Apply a reviewed scenario: each change replays through the governed
 * opportunity commands (audited, versioned); a change that no longer fits
 * the live row is reported, not forced. Owner/admin only.
 */
export async function applyScenario(
  ctx: Ctx,
  archetype: RoleArchetype,
  raw: unknown,
): Promise<{ applied: number; skipped: string[] }> {
  assertCan(archetype, "pipeline.configure");
  const input = z.object({ id: uuid, reason: z.string().trim().min(1).max(500) }).parse(raw);
  const scenarios = await listScenarios(ctx, archetype);
  const s = scenarios.find((x) => x.id === input.id);
  if (!s) throw new Error("scenario not found");
  if (s.status === "applied") throw new Error("scenario already applied");
  const skipped: string[] = [];
  let applied = 0;
  const live = (await withCtx(ctx, (tx) =>
    tx.execute(
      sql`select id::text as id, row_version, expected_close_date::text as close_date from public.opportunity where org_id = ${ctx.orgId} and status = 'open'`,
    ),
  )) as unknown as Array<{ id: string; row_version: number; close_date: string | null }>;
  const byId = new Map(live.map((l) => [l.id, l]));
  const touch = new Map<
    string,
    {
      close?: string | null;
      probability?: number;
      category?: "pipeline" | "best_case" | "commit" | "omitted";
    }
  >();
  for (const sl of s.overlay.slips) {
    const l = byId.get(sl.opportunityId);
    if (!l || !l.close_date) {
      skipped.push(sl.opportunityId);
      continue;
    }
    touch.set(sl.opportunityId, {
      ...(touch.get(sl.opportunityId) ?? {}),
      close: addMonths(l.close_date, sl.months),
    });
  }
  for (const p of s.overlay.probabilities)
    touch.set(p.opportunityId, {
      ...(touch.get(p.opportunityId) ?? {}),
      probability: p.probability,
    });
  for (const c of s.overlay.categories)
    touch.set(c.opportunityId, { ...(touch.get(c.opportunityId) ?? {}), category: c.category });
  for (const ex of s.overlay.excludes)
    touch.set(ex, { ...(touch.get(ex) ?? {}), category: "omitted" });
  for (const [id, t] of touch) {
    const l = byId.get(id);
    if (!l) {
      skipped.push(id);
      continue;
    }
    try {
      await updateCommercial(ctx, archetype, {
        id,
        rowVersion: Number(l.row_version),
        ...(t.close !== undefined ? { expectedCloseDate: t.close } : {}),
        ...(t.probability !== undefined ? { probability: t.probability } : {}),
        ...(t.category !== undefined ? { forecastCategory: t.category } : {}),
      });
      applied++;
    } catch {
      skipped.push(id);
    }
  }
  await command(
    ctx,
    {
      audit: {
        action: "crm.scenario.apply",
        entityType: "crm_scenario",
        entityId: input.id,
        summary: `${applied} applied, ${skipped.length} skipped: ${input.reason}`,
      },
    },
    async (tx) => {
      await tx.execute(sql`
        update public.crm_scenario set status = 'applied', applied_at = now(), applied_by = ${ctx.userId}
        where id = ${input.id} and org_id = ${ctx.orgId}
      `);
    },
  );
  void moveStage;
  return { applied, skipped };
}
