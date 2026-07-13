/**
 * The deterministic digest (doc 04 "Digest assembly"; doc 11 S7). Each working morning the
 * per-org nightly run COMPOSES the owner digest from authoritative DB facts and PERSISTS it
 * (one row per org/audience/date) so the morning card read is cheap and every item carries
 * an evidence reference rendered from the STRUCTURED source. The deterministic payload is
 * always produced and requires no AI (the AI-outage / no-credentials fallback).
 *
 * Money in the payload is computed at compose time by the trusted per-org run; getOwnerDigest
 * REDACTS it again at read for a non-price-privileged reader (belt-and-suspenders on the F-23
 * wall). AI narration is OPTIONAL wording generated lazily on card expand, gated by
 * feat.ai_narration + the credit meter, validated by the numbers-subset check (it can only
 * rephrase — never introduce a number), and metered into ai_interaction. Disabled by default.
 */
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { assertCan, type Action } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { hasFeature, checkLimit } from "@/platform/entitlements/resolve";
import { getNarrationProvider, type NarrationRequest } from "@/platform/ai/adapter";
import { validateNumbersSubset } from "@/platform/ai/numbers-subset";
import { logger } from "@/platform/logger";

// Each section maps to one or more of the thirteen owner questions (doc 03 §5). The label
// is an i18n KEY resolved at render; money is null unless the section carries a figure.
export type DigestSection = {
  key: string;
  labelKey: string;
  count: number;
  moneyMinor: number | null;
  items: Array<Record<string, unknown>>;
};
export type DigestPayload = {
  audience: string;
  computedAt: string;
  sections: DigestSection[];
  /** Every figure in the payload — the numbers-subset validator's allow-list for narration. */
  numbers: number[];
};

function collectNumbers(sections: DigestSection[]): number[] {
  const set = new Set<number>();
  for (const s of sections) {
    set.add(s.count);
    if (s.moneyMinor !== null) set.add(s.moneyMinor);
  }
  return [...set];
}

/**
 * Build the CLOSED AI-narration request + numbers allow-list from a digest payload.
 *
 * Money is DELIBERATELY excluded from BOTH the request and the allow-list (review finding
 * #1): the narration row is stored once and getOwnerDigest returns it verbatim to every
 * digest.view audience — including non-price-privileged manager / foreman / procurement —
 * so a money figure in the prose would bypass the F-23 section redaction. Only non-financial
 * section COUNTS (and resolved labels) cross into the model, and the allow-list is counts
 * only, so the numbers-subset validator rejects any money-looking token as offending.
 * Pure + exported so the money-exclusion invariant is unit-tested without a database.
 */
export function buildNarrationInputs(
  payload: DigestPayload,
  lang: "en" | "ar",
  t: (key: string) => string,
): { req: NarrationRequest; allowed: number[] } {
  const items = payload.sections
    .filter((s) => s.count > 0)
    .map((s) => ({ label: t(s.labelKey), numbers: [s.count] }));
  return {
    req: { lang, title: t("digest.title"), items },
    allowed: payload.sections.map((s) => s.count),
  };
}

/**
 * Compose + persist the OWNER digest for `digestDate`. Idempotent: upserts by
 * (org, 'owner', date), so a re-run (retry / duplicate delivery) replaces the row with the
 * same deterministic result. Called by the per-org nightly run.
 */
export async function composeOwnerDigest(
  ctx: Ctx,
  digestDate: string,
): Promise<{ id: string; sections: number }> {
  return withCtx(ctx, async (tx) => {
    const yesterday = shiftDate(digestDate, -1);
    const weekEnd = shiftDate(digestDate, 7);

    // Q3/Q13 — pending approvals.
    const pending = await scalar(
      tx,
      sql`
      select count(*)::int as n from public.approval where org_id = ${ctx.orgId} and state = 'pending'`,
    );

    // Q2/Q4/Q10 — open owner-audience risk exceptions. The headline count is a full
    // count(*) (never the LIMIT-10 preview length, which would silently cap at 10 and
    // understate the true total — review); items[] stay capped at 10 for display.
    const risk = (await tx.execute(sql`
      select id::text as id, rule_key, job_id::text as job_id, severity
      from public.exception
      where org_id = ${ctx.orgId} and resolved_at is null and 'owner' = any(audience_roles)
        and rule_key in ('overdue_stage','margin_drift','missing_report','approval_stuck','billing_point_uninvoiced')
      order by (severity = 'critical') desc limit 10
    `)) as unknown as Array<Record<string, unknown>>;
    const riskCount = await scalar(
      tx,
      sql`
      select count(*)::int as n from public.exception
      where org_id = ${ctx.orgId} and resolved_at is null and 'owner' = any(audience_roles)
        and rule_key in ('overdue_stage','margin_drift','missing_report','approval_stuck','billing_point_uninvoiced')`,
    );

    // Q12 — collections: overdue invoice count + AR outstanding (money, trusted compose).
    const overdue = await scalar(
      tx,
      sql`
      select count(*)::int as n from public.exception
      where org_id = ${ctx.orgId} and resolved_at is null and rule_key = 'overdue_invoice'`,
    );
    const arOutstanding = await arOutstandingMinor(tx, ctx.orgId);

    // Q6 — supply lateness.
    const supply = await scalar(
      tx,
      sql`
      select count(*)::int as n from public.exception
      where org_id = ${ctx.orgId} and resolved_at is null and rule_key in ('late_po','late_supplier')`,
    );

    // Q9 — yesterday's reports; Q7 — distinct submitters (crew activity).
    const yReports = await scalar(
      tx,
      sql`
      select count(*)::int as n from public.daily_report
      where org_id = ${ctx.orgId} and report_date = ${yesterday} and status in ('submitted','reviewed')`,
    );
    const crew = await scalar(
      tx,
      sql`
      select count(distinct submitted_by)::int as n from public.daily_report
      where org_id = ${ctx.orgId} and report_date = ${yesterday} and status in ('submitted','reviewed')`,
    );

    // Q11 — customers awaiting: active jobs with a completed billing-milestone stage and no
    // customer_update SENT in the last 14 days.
    const awaiting = (await tx.execute(sql`
      select j.id::text as job_id, j.reference from public.job j
      where j.org_id = ${ctx.orgId} and j.status_category = 'active' and j.archived = false
        and exists (
          select 1 from public.job_stage s where s.job_id = j.id and s.org_id = ${ctx.orgId}
            and s.status = 'completed'
            and s.stage_key in (select bp->>'trigger' from jsonb_array_elements(j.billing_points) bp
                                where bp->>'trigger' <> 'on_acceptance')
        )
        and not exists (
          select 1 from public.customer_update cu where cu.job_id = j.id and cu.org_id = ${ctx.orgId}
            and cu.status = 'sent' and cu.sent_at >= (${digestDate}::date - 14)
        )
      limit 10
    `)) as unknown as Array<Record<string, unknown>>;
    const awaitingCount = await scalar(
      tx,
      sql`
      select count(*)::int as n from public.job j
      where j.org_id = ${ctx.orgId} and j.status_category = 'active' and j.archived = false
        and exists (
          select 1 from public.job_stage s where s.job_id = j.id and s.org_id = ${ctx.orgId}
            and s.status = 'completed'
            and s.stage_key in (select bp->>'trigger' from jsonb_array_elements(j.billing_points) bp
                                where bp->>'trigger' <> 'on_acceptance'))
        and not exists (
          select 1 from public.customer_update cu where cu.job_id = j.id and cu.org_id = ${ctx.orgId}
            and cu.status = 'sent' and cu.sent_at >= (${digestDate}::date - 14))`,
    );

    // Q1/Q5 — this week: jobs due within the window + approved MRs awaiting conversion.
    const dueThisWeek = await scalar(
      tx,
      sql`
      select count(*)::int as n from public.job
      where org_id = ${ctx.orgId} and status_category = 'active' and archived = false
        and due_date is not null and due_date between ${digestDate} and ${weekEnd}`,
    );
    const mrsAwaiting = await scalar(
      tx,
      sql`
      select count(*)::int as n from public.material_request
      where org_id = ${ctx.orgId} and status = 'approved'`,
    );

    const sections: DigestSection[] = [
      {
        key: "needs_decision",
        labelKey: "digest.section.needs_decision",
        count: pending,
        moneyMinor: null,
        items: [],
      },
      {
        key: "at_risk",
        labelKey: "digest.section.at_risk",
        count: riskCount,
        moneyMinor: null,
        items: risk.map((r) => ({
          id: r.id,
          ruleKey: r.rule_key,
          jobId: r.job_id,
          severity: r.severity,
        })),
      },
      {
        key: "collections",
        labelKey: "digest.section.collections",
        count: overdue,
        moneyMinor: arOutstanding,
        items: [],
      },
      {
        key: "supply",
        labelKey: "digest.section.supply",
        count: supply,
        moneyMinor: null,
        items: [],
      },
      {
        key: "yesterday",
        labelKey: "digest.section.yesterday",
        count: yReports,
        moneyMinor: null,
        items: [],
      },
      { key: "crew", labelKey: "digest.section.crew", count: crew, moneyMinor: null, items: [] },
      {
        key: "customers_awaiting",
        labelKey: "digest.section.customers_awaiting",
        count: awaitingCount,
        moneyMinor: null,
        items: awaiting.map((a) => ({ jobId: a.job_id, reference: a.reference })),
      },
      {
        key: "this_week",
        labelKey: "digest.section.this_week",
        count: dueThisWeek + mrsAwaiting,
        moneyMinor: null,
        items: [],
      },
    ];

    const payload: DigestPayload = {
      audience: "owner",
      computedAt: new Date().toISOString(),
      sections,
      numbers: collectNumbers(sections),
    };

    const narrationStatus = (await hasFeature(ctx, "feat.ai_narration")) ? "pending" : "disabled";
    const rows = (await tx.execute(sql`
      insert into public.digest (org_id, audience, digest_date, payload, narration_status)
      values (${ctx.orgId}, 'owner', ${digestDate}, ${JSON.stringify(payload)}::jsonb, ${narrationStatus})
      on conflict (org_id, audience, digest_date)
      do update set payload = excluded.payload, computed_at = now(),
                    narration = null, narration_lang = null, narration_status = excluded.narration_status,
                    updated_at = now()
      returning id::text as id
    `)) as unknown as Array<{ id: string }>;
    return { id: rows[0]!.id, sections: sections.length };
  });
}

export type OwnerDigestView = {
  id: string;
  digestDate: string;
  computedAt: string;
  sections: DigestSection[];
  narration: string | null;
  narrationStatus: string;
};

/** Read the latest (or a specific date's) owner digest, money-redacted per the READER. */
export async function getOwnerDigest(
  ctx: Ctx,
  archetype: RoleArchetype,
  digestDate?: string,
): Promise<OwnerDigestView | null> {
  assertCan(archetype, "digest.view" as Action);
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, digest_date::text as digest_date, computed_at::text as computed_at,
             payload, narration, narration_status
      from public.digest
      where org_id = ${ctx.orgId} and audience = 'owner'
        ${digestDate ? sql`and digest_date = ${digestDate}` : sql``}
      order by digest_date desc limit 1
    `)) as unknown as Array<Record<string, unknown>>;
    if (!rows[0]) return null;
    const r = rows[0];
    const payload = r.payload as DigestPayload;
    // Redact money for a non-price-privileged reader (F-23 backstop at the read boundary).
    const sections = payload.sections.map((s) => ({
      ...s,
      moneyMinor: ctx.pricePrivileged ? s.moneyMinor : null,
    }));
    return {
      id: r.id as string,
      digestDate: r.digest_date as string,
      computedAt: (r.computed_at as string) ?? payload.computedAt,
      sections,
      narration: (r.narration as string | null) ?? null,
      narrationStatus: r.narration_status as string,
    };
  });
}

/**
 * Lazy AI narration (on card expand). Gated by feat.ai_narration + the monthly credit meter;
 * builds a CLOSED payload (labels + numbers only — no raw tenant text), calls the provider,
 * VALIDATES numbers-subset (fail ⇒ keep the deterministic digest), meters into ai_interaction,
 * and stores the narration. Returns the narration or null. Never throws on provider failure.
 */
export async function generateOwnerNarration(
  ctx: Ctx,
  archetype: RoleArchetype,
  digestId: string,
  lang: "en" | "ar",
  t: (key: string) => string,
): Promise<{ narration: string | null; status: string }> {
  assertCan(archetype, "digest.view" as Action);
  if (!(await hasFeature(ctx, "feat.ai_narration"))) return { narration: null, status: "disabled" };

  // Credit meter: count this month's narration + draft credits used.
  const used = await withCtx(ctx, (tx) =>
    scalar(
      tx,
      sql`
      select coalesce(sum(credits),0)::int as n from public.ai_interaction
      where org_id = ${ctx.orgId} and created_at >= date_trunc('month', now())`,
    ),
  );
  const room = await checkLimit(ctx, "limit.ai_credits_month", used);
  if (!room.allowed) return { narration: null, status: "credits_exhausted" };

  const digest = await withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select payload, narration_status from public.digest
      where id = ${digestId} and org_id = ${ctx.orgId}`)) as unknown as Array<
      Record<string, unknown>
    >;
    return rows[0];
  });
  if (!digest) return { narration: null, status: "not_found" };
  const payload = digest.payload as DigestPayload;

  const { req, allowed } = buildNarrationInputs(payload, lang, t);
  const provider = getNarrationProvider();
  let result;
  try {
    result = await provider.narrate(req);
  } catch (err) {
    logger.warn(
      { orgId: ctx.orgId, err: (err as Error).message },
      "digest narration provider failed",
    );
    result = null;
  }

  // `allowed` (from buildNarrationInputs) is the COUNTS-only set — a narration can never
  // legitimise a money figure (any money-looking token → offending → fall back to deterministic).
  let verdict: "pass" | "fail" | "na" = "na";
  let narration: string | null = null;
  let status = "failed";
  if (result && result.status === "generated" && result.text) {
    const check = validateNumbersSubset(result.text, allowed);
    verdict = check.ok ? "pass" : "fail";
    if (check.ok) {
      narration = result.text;
      status = "generated";
    }
  } else if (result && result.status === "disabled") {
    status = "disabled";
  }

  // Meter + persist the interaction (append-only ledger) and, on pass, the narration.
  await withCtx(ctx, async (tx) => {
    await tx.execute(sql`
      insert into public.ai_interaction
        (org_id, feature, provider, model, input_tokens, output_tokens, credits, validator_verdict,
         status, subject_type, subject_id, created_by)
      values (${ctx.orgId}, 'digest_narration', ${result?.provider ?? "disabled"}, ${result?.model ?? null},
              ${result?.inputTokens ?? 0}, ${result?.outputTokens ?? 0}, ${narration ? 1 : 0}, ${verdict},
              ${status === "generated" ? "ok" : status === "disabled" ? "disabled" : "failed"},
              'digest', ${digestId}, ${ctx.userId})`);
    await tx.execute(sql`
      update public.digest
      set narration = ${narration}, narration_lang = ${narration ? lang : null},
          narration_status = ${narration ? "generated" : status === "disabled" ? "disabled" : "failed"},
          updated_at = now()
      where id = ${digestId} and org_id = ${ctx.orgId}`);
  });
  return { narration, status };
}

// ── helpers ──────────────────────────────────────────────────────────────────────
async function scalar(tx: TenantTx, q: ReturnType<typeof sql>): Promise<number> {
  const rows = (await tx.execute(q)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/** AR outstanding (base minor units) — the same net as computeAR, but trusted (no ctx gate),
 * for the compose step. Credit notes offset the invoice they correct, floored at 0. */
async function arOutstandingMinor(tx: TenantTx, orgId: string): Promise<number> {
  const rows = (await tx.execute(sql`
    with inv as (
      select greatest(0,
        i.base_total_minor
        - coalesce((select sum(p.base_amount_minor) from public.payment p
                    where p.invoice_id = i.id and p.org_id = ${orgId} and p.status in ('recorded','confirmed')), 0)
        - coalesce((select sum(cn.base_total_minor) from public.invoice cn
                    where cn.corrects_invoice_id = i.id and cn.org_id = ${orgId}
                      and cn.kind = 'credit_note' and cn.status <> 'cancelled'), 0)
      ) as bal
      from public.invoice i
      where i.org_id = ${orgId} and i.kind = 'invoice' and i.status in ('issued','partially_paid')
    )
    select coalesce(sum(bal),0)::bigint as n from inv where bal > 0
  `)) as unknown as Array<{ n: string }>;
  return Number(rows[0]?.n ?? 0);
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
