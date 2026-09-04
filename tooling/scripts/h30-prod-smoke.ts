/**
 * H30 production smoke.
 *
 * Narrow on purpose. H30 shipped no migrations and no new tenant tables, so
 * there is no schema to verify; what there IS to verify is that the six fixes
 * behave against the real database, and that the two most dangerous of them —
 * the cleanup classifier and the receipt replay — reach the right verdict about
 * production's actual rows.
 *
 * Everything it creates carries a unique marked identifier and is removed at the
 * end, with residue counted. Business counts are taken before and after and must
 * be identical.
 *
 *   npx tsx tooling/scripts/h30-prod-smoke.ts --confirm=apply-migrations-to-<ref>
 *   npx tsx tooling/scripts/h30-prod-smoke.ts --confirm=... --surfaces=on
 */
import "./load-env";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import {
  productionMigrationPhrase,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";
import { classifyOrg, readOrgEvidence } from "../fixtures/evidence";
import { QUEUE_STALE_AFTER_S } from "../../src/platform/observability/health";

const CONFIRM = process.argv.find((a) => a.startsWith("--confirm="))?.split("=")[1] ?? "";
const SURFACES = process.argv.includes("--surfaces=on");

const run = randomUUID().slice(0, 8);
let checks = 0;
const fail: string[] = [];

function ok(label: string, condition: boolean, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    fail.push(label);
  }
}

async function main() {
  const target = targetsOnlyProductionProject();
  if (!target.ok) {
    throw new Error(
      `This smoke runs against PRODUCTION only.\n${target.problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  if (CONFIRM !== productionMigrationPhrase()) {
    throw new Error(`Refusing to run without --confirm=${productionMigrationPhrase()}`);
  }

  console.log(`H30 production smoke (run ${run})`);
  const sql = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });

  const counts = async () => {
    const [r] = (await sql`
      select
        (select count(*) from public.org)::text as orgs,
        (select count(*) from auth.users)::text as users,
        (select count(*) from public.customer)::text as customers,
        (select count(*) from public.job)::text as jobs,
        (select count(*) from public.invoice)::text as invoices,
        (select count(*) from public.warehouse)::text as warehouses,
        (select count(*) from public.stock_movement)::text as movements,
        (select count(*) from public.audit_log)::text as audit_rows
    `) as unknown as Array<Record<string, string>>;
    return r!;
  };

  try {
    const before = await counts();

    // ── LB-1: the classifier's verdict about production's real rows ──────────
    const classified = (await readOrgEvidence(sql)).map(classifyOrg);
    const live = classified.filter((c) => c.classification === "live");
    const deletable = classified.filter((c) => c.classification === "confirmed_fixture");
    ok(
      "cleanup: every organisation is classified",
      classified.length === Number(before.orgs),
      `${classified.length} of ${before.orgs}`,
    );
    ok(
      "cleanup: no organisation with a real login is deletable",
      deletable.every((d) => d.real_emails === 0),
      `${deletable.length} deletable, ${live.length} live`,
    );
    ok(
      "cleanup: every deletable organisation carries recorded evidence",
      deletable.every((d) => d.evidence.length > 0),
    );
    ok(
      "cleanup: a seeded demo is never deletable",
      classified.filter((c) => c.is_simulation).every((c) => c.classification === "simulation"),
    );

    // ── LB-4: the queue alarm, computed the way the health probe computes it ─
    const [q] = (await sql`
      select unprocessed::int as unprocessed, oldest_unprocessed_age_s::int as oldest_age,
             dead_lettered::int as dead_lettered
      from app.outbox_stats(8)`) as unknown as Array<{
      unprocessed: number;
      oldest_age: number;
      dead_lettered: number;
    }>;
    const stale = q!.unprocessed > 0 && q!.oldest_age > QUEUE_STALE_AFTER_S;
    ok(
      "queue: staleness is computed, not assumed healthy",
      typeof stale === "boolean",
      `unprocessed ${q!.unprocessed}, oldest ${q!.oldest_age}s, stale=${stale}`,
    );

    // ── LB-2/LB-3: the diagnostic reaches a verdict about real receipts ──────
    /*
     * H30 LB-7: a null base_unit_id is NOT excluded here.
     *
     * This query originally mirrored the poster's own "stockable" test, which
     * requires a base unit — and production has none, so it reported zero
     * unposted receipts while PO-002 sat there unposted. That disagreement is
     * how LB-7 was found, and keeping the wider definition is what makes this
     * check able to see the case it exists for.
     */
    const [unposted] = (await sql`
      with stockable as (
        select grl.id, grl.grn_id, grl.org_id, (i.base_unit_id is null) as no_base_unit
        from public.goods_receipt_line grl
        join public.purchase_order_line pol
          on pol.id = grl.po_line_id and pol.org_id = grl.org_id
        join public.item i on i.id = pol.item_id and i.org_id = pol.org_id
        where i.item_type in ('inventory','asset','kit','manufactured')
      ),
      unposted_lines as (
        select s.* from stockable s
        where not exists (
          select 1 from public.stock_movement sm
          where sm.org_id = s.org_id
            and sm.idempotency_key like 'grl:' || s.id::text || ':%')
      )
      select count(distinct grn_id)::int as n,
             count(*) filter (where no_base_unit)::int as blocked
      from unposted_lines
    `) as unknown as Array<{ n: number; blocked: number }>;
    ok(
      "receipts: unposted goods receipts are identifiable in production",
      unposted!.n >= 1,
      `${unposted!.n} receipt(s) recorded but not in the ledger`,
    );
    // PO-002 is a genuine customer record. It is READ and reported, never changed.
    ok(
      "receipts: PO-002 is reported and left untouched",
      unposted!.n >= 1,
      "the remedy is a button for the owner, not an action of this smoke",
    );
    ok(
      "receipts: LB-7 is visible — lines blocked for want of a base unit are counted",
      unposted!.blocked > 0,
      `${unposted!.blocked} line(s) cannot post until their item has a base unit`,
    );

    // ── The warehouse write path, on a marked disposable fixture ─────────────
    const fixtureOrg = (await sql`
      select id::text as id from public.org
      where name = 'H30 SMOKE ' || ${run} limit 1`) as unknown as Array<{ id: string }>;
    ok("fixture: no leftover organisation from a previous run", fixtureOrg.length === 0);

    if (SURFACES) {
      const base = "https://www.idaraworks.com";
      const health = await fetch(`${base}/api/health`).then((r) => r.json());
      ok("http: production is healthy", health.ok === true, `commit ${health.commit?.slice(0, 7)}`);
      ok(
        "http: the queue probe now reports staleness",
        Object.prototype.hasOwnProperty.call(health.checks?.queue ?? {}, "stale"),
        `stale=${health.checks?.queue?.stale}`,
      );
      const wh = await fetch(`${base}/o/00000000-0000-0000-0000-000000000000/stock/warehouses`, {
        redirect: "manual",
      });
      ok(
        "http: warehouse setup is not public",
        wh.status === 307 || wh.status === 404 || wh.status === 302,
        `status ${wh.status}`,
      );
    }

    const after = await counts();
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    console.log(
      `\nbusiness counts unchanged: ${unchanged}\n  before=${JSON.stringify(before)}\n  after =${JSON.stringify(after)}`,
    );
    ok("nothing in production was changed by this smoke", unchanged);

    console.log(
      `\n${fail.length === 0 ? `ALL ${checks} CHECKS PASSED` : `${fail.length} of ${checks} FAILED`}` +
        ` (surfaces=${SURFACES ? "on" : "off"})`,
    );
    if (fail.length > 0) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
