/**
 * H33 Pilot Lab — targeted repairs for what reconciliation found.
 *
 *   npx tsx tooling/pilot-lab/repair.ts            # preview
 *   npx tsx tooling/pilot-lab/repair.ts --confirm  # apply
 *
 * Two of the six reconciliation findings need a correction to rows that already
 * exist rather than a re-seed, because the generator that produced them is now
 * right and only the history is stale:
 *
 *   1. A maintenance plan's `last_done_on` and `next_due_on`, set from the
 *      plan's OLDEST occurrence instead of its newest, because the generating
 *      loop counts down in days-ago and a comment claimed it counted up.
 *      Recomputed from the plan's own events. The generator is now right, so a
 *      future clean seed finds nothing here; this repairs the builds made
 *      before the fix landed.
 *   2. The payroll periods hr should never have written. setup owns the pay
 *      calendar and derives one id per calendar month of the company's
 *      history; anything else on that calendar came from hr's old thirty-day
 *      series, which put two overlapping period sets on one pay group. They are
 *      identified by DERIVATION — recompute setup's ids and delete what is not
 *      among them — rather than by guessing at their shape.
 *   3. A Studio edge citing a `task_dependency` row that is not there. The
 *      pointer is nulled; the underlying defect is in the product's `addEdge`,
 *      which materialises the dependency outside its own transaction, and is
 *      reported separately rather than patched here.
 *
 * Only organisations carrying the H33 marker are touched, re-checked inside the
 * transaction, and the lab guard refuses anything but the test project.
 */
import { loadLabEnv } from "./guard";
import { openOwner } from "./db";
import { MARKER_KEY } from "./marker";
import { COMPANIES } from "./companies";
import { findLabOrg } from "./provision";
import { monthSpans } from "./families/setup";
import { id as labId } from "./ids";

const CONFIRM = process.argv.includes("--confirm");

async function main() {
  const env = loadLabEnv();
  const sql = openOwner(env);
  try {
    const orgs = (await sql`
      select org_id::text as id from public.app_settings where key = ${MARKER_KEY}
    `) as unknown as Array<{ id: string }>;
    const ids = orgs.map((o) => o.id);
    console.log(`H33 repair — ${ids.length} marked organisations in ${env.ref}`);
    if (!ids.length) return;

    const [plans] = (await sql`
      select count(*)::int as n from public.asset_maintenance_plan p
      where p.org_id = any(${ids}::uuid[])
        and p.last_done_on is distinct from (
          select max(e.performed_on) from public.asset_maintenance_event e
          where e.org_id = p.org_id and e.plan_id = p.id)
        and exists (select 1 from public.asset_maintenance_event e
                    where e.org_id = p.org_id and e.plan_id = p.id)
    `) as unknown as Array<{ n: number }>;
    /*
     * Recompute the ids setup derives for this company's pay calendar; every
     * other period on it is one hr minted and should not exist.
     */
    const orphanPeriods: string[] = [];
    for (const c of COMPANIES) {
      const org = await findLabOrg(sql, c.key);
      if (!org) continue;
      /*
       * The family segment is NOT optional. setup mints these as
       * ctx.id(FAMILY, "pay_period", start), which is labId(key, "setup",
       * "pay_period", start); recomputing without "setup" derives a different
       * uuid for every period, so every real one looks like an orphan and this
       * repair would delete the company's whole payroll calendar.
       */
      const mine = new Set(
        monthSpans(c.history.from, c.history.asOf).map((sp) =>
          labId(c.key, "setup", "pay_period", sp.start),
        ),
      );
      const live = (await sql`
        select id::text as id from public.pay_period where org_id = ${org}
      `) as unknown as Array<{ id: string }>;
      for (const r of live) if (!mine.has(r.id)) orphanPeriods.push(r.id);
    }

    /*
     * A material line marked as having deducted stock, on a report nobody has
     * accepted. The line was flagged because the report was "submitted"; the
     * top-up that guarantees every report status appears then demoted it to
     * draft or returned without taking the deduction with it. The generator
     * now clears it; these are the rows written before that landed.
     */
    const [deducts] = (await sql`
      select count(*)::int as n from public.report_material_line l
      join public.daily_report r on r.id = l.report_id
      where l.org_id = any(${ids}::uuid[]) and l.deducted_from_inventory
        and (l.item_id is null or r.status not in ('submitted', 'reviewed'))
    `) as unknown as Array<{ n: number }>;

    /*
     * next_due_on that is not last_done_on plus the interval. The family
     * asserts that invariant, and an earlier version of THIS tool broke it on
     * one consult plan while trying to force an overdue row - recorded rather
     * than quietly corrected, because a repair that breaks an invariant is
     * worth remembering.
     */
    const [dues] = (await sql`
      select count(*)::int as n from public.asset_maintenance_plan p
      where p.org_id = any(${ids}::uuid[]) and p.last_done_on is not null
        and p.interval_days is not null
        and p.next_due_on is distinct from (p.last_done_on + (p.interval_days || ' days')::interval)::date
    `) as unknown as Array<{ n: number }>;

    /*
     * A company whose maintenance due list is empty. Correcting last_done_on to
     * the plan's newest event (D14) moved every due date forward with it, and
     * consult was left with nothing due at all - a screen the owner opens and
     * finds blank. The generator now guarantees one overdue plan, but asset
     * history is append-only, so a company already seeded cannot be re-run.
     *
     * This SHORTENS one plan's interval, which is a schedule the owner sets,
     * rather than forcing next_due_on to a date that contradicts it. An earlier
     * version of this repair did exactly that and broke the family's own rule
     * that a serviced plan's next due is its last service plus its interval.
     */
    const emptyDueLists: Array<{ org: string; asOf: string }> = [];
    for (const c of COMPANIES) {
      const org = await findLabOrg(sql, c.key);
      if (!org) continue;
      const [n] = (await sql`
        select count(*)::int as n from public.asset_maintenance_plan
        where org_id = ${org} and active and next_due_on < ${c.history.asOf}::date
      `) as unknown as Array<{ n: number }>;
      if ((n?.n ?? 0) === 0) emptyDueLists.push({ org, asOf: c.history.asOf });
    }

    const [edges] = (await sql`
      select count(*)::int as n from public.studio_edge e
      where e.org_id = any(${ids}::uuid[]) and e.task_dependency_id is not null
        and not exists (select 1 from public.task_dependency d
                        where d.id = e.task_dependency_id and d.org_id = e.org_id)
    `) as unknown as Array<{ n: number }>;

    console.log(`  maintenance plans behind their own newest event: ${plans!.n}`);
    console.log(`  studio edges citing a dependency that is not there: ${edges!.n}`);
    console.log(`  payroll periods setup did not derive: ${orphanPeriods.length}`);
    console.log(`  deductions on reports nobody accepted: ${deducts!.n}`);
    console.log(`  next due dates off their own interval: ${dues!.n}`);
    console.log(`  companies whose maintenance due list is empty: ${emptyDueLists.length}`);
    /*
     * A repair that wants to delete the entire calendar is not a repair, it is
     * a derivation that has drifted from the generator. Refuse rather than
     * obey: deleting every pay_period would take the pay runs citing them with
     * it, and pay_run is append-only.
     */
    const [livePeriods] = (await sql`
      select count(*)::int as n from public.pay_period where org_id = any(${ids}::uuid[])
    `) as unknown as Array<{ n: number }>;
    if (orphanPeriods.length && orphanPeriods.length >= (livePeriods?.n ?? 0)) {
      throw new Error(
        `refusing: ${orphanPeriods.length} of ${livePeriods?.n ?? 0} pay periods look ` +
          "undrived, which means this tool's derivation no longer matches the setup " +
          "family, not that the data is wrong. Fix the derivation before running again.",
      );
    }

    if (!CONFIRM) {
      console.log("\npreview only — pass --confirm to apply");
      return;
    }

    await sql.begin(async (tx) => {
      const marked = (await tx`
        select org_id::text as id from public.app_settings where key = ${MARKER_KEY}
      `) as unknown as Array<{ id: string }>;
      const safe = marked.map((m) => m.id);
      if (safe.length !== ids.length) throw new Error("the marked set changed underneath us");

      await tx`
        update public.asset_maintenance_plan p
        set last_done_on = latest.performed_on,
            next_due_on = case
              when p.interval_days is null then p.next_due_on
              else (latest.performed_on + (p.interval_days || ' days')::interval)::date
            end,
            updated_at = now()
        from (
          select e.plan_id, e.org_id, max(e.performed_on) as performed_on
          from public.asset_maintenance_event e
          where e.org_id = any(${safe}::uuid[]) and e.plan_id is not null
          group by e.plan_id, e.org_id
        ) latest
        where p.id = latest.plan_id and p.org_id = latest.org_id
          and p.last_done_on is distinct from latest.performed_on
      `;
      if (orphanPeriods.length) {
        await tx`
          delete from public.pay_period
          where org_id = any(${safe}::uuid[]) and id = any(${orphanPeriods}::uuid[])
        `;
      }
      for (const e of emptyDueLists) {
        if (!safe.includes(e.org)) throw new Error("unmarked org in the due-list repair");
        await tx`
          update public.asset_maintenance_plan p
          set interval_days = (${e.asOf}::date - 20) - p.last_done_on,
              next_due_on = (${e.asOf}::date - 20),
              updated_at = now()
          where p.org_id = ${e.org} and p.id = (
            select id from public.asset_maintenance_plan
            where org_id = ${e.org} and active and last_done_on is not null
              and interval_days is not null
              and (${e.asOf}::date - 20) - last_done_on >= 7
            order by last_done_on asc, id asc limit 1)
        `;
      }
      await tx`
        update public.asset_maintenance_plan p
        set next_due_on = (p.last_done_on + (p.interval_days || ' days')::interval)::date,
            updated_at = now()
        where p.org_id = any(${safe}::uuid[]) and p.last_done_on is not null
          and p.interval_days is not null
          and p.next_due_on is distinct from (p.last_done_on + (p.interval_days || ' days')::interval)::date
      `;
      await tx`
        update public.report_material_line l
        set deducted_from_inventory = false, cost_only = true
        from public.daily_report r
        where r.id = l.report_id and l.org_id = any(${safe}::uuid[])
          and l.deducted_from_inventory
          and (l.item_id is null or r.status not in ('submitted', 'reviewed'))
      `;
      await tx`
        update public.studio_edge e set task_dependency_id = null
        where e.org_id = any(${safe}::uuid[]) and e.task_dependency_id is not null
          and not exists (select 1 from public.task_dependency d
                          where d.id = e.task_dependency_id and d.org_id = e.org_id)
      `;
    });
    console.log("\napplied");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
