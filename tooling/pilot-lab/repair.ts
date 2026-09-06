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
 *   1. A maintenance plan's `last_done_on` and `next_due_on`, left one interval
 *      behind when the service recorded the newest event without advancing the
 *      plan. Recomputed from the plan's own events.
 *   2. A Studio edge citing a `task_dependency` row that is not there. The
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
    const [edges] = (await sql`
      select count(*)::int as n from public.studio_edge e
      where e.org_id = any(${ids}::uuid[]) and e.task_dependency_id is not null
        and not exists (select 1 from public.task_dependency d
                        where d.id = e.task_dependency_id and d.org_id = e.org_id)
    `) as unknown as Array<{ n: number }>;

    console.log(`  maintenance plans behind their own newest event: ${plans!.n}`);
    console.log(`  studio edges citing a dependency that is not there: ${edges!.n}`);
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
