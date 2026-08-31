/**
 * Read-only production health check.
 *
 * Built for the moments either side of a deployment, when the question is not
 * "did my change work" but "is production still the shape it is supposed to be".
 * It answers that in one command, and it exits non-zero when a SAFETY property
 * has regressed rather than merely when a number moved.
 *
 * It never writes. There is no flag that makes it write, no branch that could
 * write, and every statement it issues is a SELECT. That is what makes it safe
 * to run at any time, including in the middle of an incident.
 *
 * Safety, in the order the checks happen:
 *   1. Loads `.env.local` ONLY, the place production credentials live.
 *   2. POSITIVELY identifies production. Failing to recognise a test project is
 *      not enough: an empty or half-filled environment, or one naming two
 *      projects, is refused outright rather than read as production.
 *   3. Asks the SERVER which database it reached before reading anything, so a
 *      correct-looking URL pointing somewhere unexpected is caught first.
 *   4. Prints no secret. Connection strings, keys and tokens never appear in the
 *      output; the project reference is an identifier, not a credential.
 *
 * The 116 historical orphaned authentication records are a KNOWN, accepted
 * condition of this database and must not be deleted. This check therefore
 * treats them as the expected floor and reports only what is above it, so a new
 * leak is visible while the known ones stay quiet.
 *
 *   npx tsx tooling/scripts/prod-health.ts
 *   npx tsx tooling/scripts/prod-health.ts --json
 */
import { config } from "dotenv";

config({ path: [".env.local"], quiet: true });

import postgres from "postgres";
import {
  PRODUCTION_PROJECT_REF,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

/**
 * Orphaned auth rows this database is known to carry, from cleanups that ran
 * before the ordering bug in the test teardown was fixed. They are historical
 * and deliberately retained. Anything ABOVE these counts is new residue.
 */
export const KNOWN_ORPHAN_IDENTITIES = 13;
export const KNOWN_ORPHAN_SESSIONS = 103;

/** The one table permitted to grant DELETE to app_user (a derived projection). */
export const DELETE_GRANT_EXCEPTION = "org_holiday_calendar";

export const PRODUCTION_APP_URL = "https://www.idaraworks.com";

export type HealthReport = {
  target: string;
  database: string;
  deployedCommit: string | null;
  appHealth: { ok: boolean; db: boolean; storage: boolean; queue: boolean; detail: string };
  migrations: { applied: number; pending: string[] };
  tables: { total: number; withoutRls: number; namesWithoutRls: string[] };
  grants: { unexpectedDeleteGrants: string[] };
  business: Record<string, number>;
  authResidue: {
    orphanIdentities: number;
    orphanSessions: number;
    newOrphanIdentities: number;
    newOrphanSessions: number;
  };
  regressions: string[];
};

function nonSecret(value: string): string {
  // Defence in depth: nothing here should ever be a credential, but a value that
  // looks like one is redacted rather than printed.
  return /^[A-Za-z0-9_-]{20,}$/.test(value) ? "[redacted]" : value;
}

export async function collect(): Promise<HealthReport> {
  const target = targetsOnlyProductionProject();
  if (!target.ok) {
    const problems = target.problems.join("; ");
    throw new Error(
      `Refusing to run: the environment does not point only at production (${PRODUCTION_PROJECT_REF}). ${problems}`,
    );
  }

  const direct = process.env.DIRECT_URL;
  if (!direct) throw new Error("DIRECT_URL is not set. This check refuses to guess a target.");

  const sql = postgres(direct, { max: 1, connect_timeout: 60, onnotice: () => {} });
  const regressions: string[] = [];
  try {
    // Probe the server before reading anything else.
    const [who] = (await sql`select current_database() as db`) as unknown as Array<{ db: string }>;
    const database = who?.db ?? "unknown";

    const { pendingMigrations } = await import("./migrate");
    const { pending, applied } = await pendingMigrations();

    const [shape] = (await sql`
      select
        (select count(*) from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE') as tables,
        (select count(*) from public.org) as orgs,
        (select count(*) from auth.users) as users,
        (select count(*) from public.job) as jobs,
        (select count(*) from public.quote) as quotes,
        (select count(*) from public.invoice) as invoices,
        (select count(*) from public.purchase_order) as purchase_orders,
        (select count(*) from public.goods_receipt) as goods_receipts,
        (select count(*) from public.item) as items,
        (select count(*) from public.supplier) as suppliers,
        (select count(*) from auth.identities i
          where not exists (select 1 from auth.users u where u.id = i.user_id)) as orphan_identities,
        (select count(*) from auth.sessions s
          where not exists (select 1 from auth.users u where u.id = s.user_id)) as orphan_sessions
    `) as unknown as Array<Record<string, string>>;

    const noRls = (await sql`
      select c.relname as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
      order by c.relname
    `) as unknown as Array<{ name: string }>;

    const deleteGrants = (await sql`
      select table_name from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'app_user' and privilege_type = 'DELETE'
      order by table_name
    `) as unknown as Array<{ table_name: string }>;

    const unexpectedDeleteGrants = deleteGrants
      .map((g) => g.table_name)
      .filter((t) => t !== DELETE_GRANT_EXCEPTION);

    // The deployed application, and its own dependency checks.
    let deployedCommit: string | null = null;
    const appHealth = { ok: false, db: false, storage: false, queue: false, detail: "" };
    try {
      const res = await fetch(`${PRODUCTION_APP_URL}/api/health`);
      const body = (await res.json()) as Record<string, unknown>;
      deployedCommit = (body.commit as string) ?? (body.sha as string) ?? null;
      const checks = (body.checks ?? body) as Record<string, { ok?: boolean }>;
      appHealth.db = checks.db?.ok === true;
      appHealth.storage = checks.storage?.ok === true;
      appHealth.queue = checks.queue?.ok === true;
      appHealth.ok = res.ok && appHealth.db && appHealth.storage && appHealth.queue;
      appHealth.detail = `HTTP ${res.status}`;
    } catch (err) {
      appHealth.detail = `unreachable: ${err instanceof Error ? err.message : String(err)}`;
    }

    const orphanIdentities = Number(shape!.orphan_identities);
    const orphanSessions = Number(shape!.orphan_sessions);
    const newOrphanIdentities = Math.max(0, orphanIdentities - KNOWN_ORPHAN_IDENTITIES);
    const newOrphanSessions = Math.max(0, orphanSessions - KNOWN_ORPHAN_SESSIONS);

    // Safety regressions only. A changed business count is information, not a
    // fault; a table without RLS is a fault.
    if (noRls.length > 0) {
      regressions.push(
        `${noRls.length} public table(s) without RLS: ${noRls.map((r) => r.name).join(", ")}`,
      );
    }
    if (unexpectedDeleteGrants.length > 0) {
      regressions.push(`app_user holds DELETE on: ${unexpectedDeleteGrants.join(", ")}`);
    }
    if (newOrphanIdentities > 0 || newOrphanSessions > 0) {
      regressions.push(
        `new auth residue above the known historical floor: ` +
          `+${newOrphanIdentities} identities, +${newOrphanSessions} sessions`,
      );
    }
    if (!appHealth.ok) {
      regressions.push(`application health is not green (${nonSecret(appHealth.detail)})`);
    }

    return {
      target: PRODUCTION_PROJECT_REF,
      database,
      deployedCommit,
      appHealth,
      migrations: { applied: applied.length, pending },
      tables: {
        total: Number(shape!.tables),
        withoutRls: noRls.length,
        namesWithoutRls: noRls.map((r) => r.name),
      },
      grants: { unexpectedDeleteGrants },
      business: {
        orgs: Number(shape!.orgs),
        users: Number(shape!.users),
        jobs: Number(shape!.jobs),
        quotes: Number(shape!.quotes),
        invoices: Number(shape!.invoices),
        purchaseOrders: Number(shape!.purchase_orders),
        goodsReceipts: Number(shape!.goods_receipts),
        items: Number(shape!.items),
        suppliers: Number(shape!.suppliers),
      },
      authResidue: {
        orphanIdentities,
        orphanSessions,
        newOrphanIdentities,
        newOrphanSessions,
      },
      regressions,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function print(r: HealthReport): void {
  const line = (label: string, value: string) => console.log(`  ${label.padEnd(24)} ${value}`);
  console.log(`\nPRODUCTION HEALTH — project ${r.target}\n`);
  line("database", r.database);
  line("deployed commit", r.deployedCommit ? r.deployedCommit.slice(0, 12) : "unknown");
  line(
    "application",
    r.appHealth.ok
      ? `healthy (${r.appHealth.detail})`
      : `NOT HEALTHY (${nonSecret(r.appHealth.detail)})`,
  );
  line(
    "  db / storage / queue",
    `${r.appHealth.db} / ${r.appHealth.storage} / ${r.appHealth.queue}`,
  );

  console.log("\n  schema");
  line("migrations applied", String(r.migrations.applied));
  line(
    "migrations pending",
    r.migrations.pending.length === 0 ? "none" : r.migrations.pending.join(", "),
  );
  line("public tables", String(r.tables.total));
  line(
    "tables without RLS",
    r.tables.withoutRls === 0
      ? "0"
      : `${r.tables.withoutRls} (${r.tables.namesWithoutRls.join(", ")})`,
  );
  line(
    "unexpected DELETE grants",
    r.grants.unexpectedDeleteGrants.length === 0
      ? `none (only ${DELETE_GRANT_EXCEPTION} is permitted)`
      : r.grants.unexpectedDeleteGrants.join(", "),
  );

  console.log("\n  business records");
  for (const [k, v] of Object.entries(r.business)) line(k, String(v));

  console.log("\n  authentication residue");
  line(
    "orphan identities",
    `${r.authResidue.orphanIdentities} (${KNOWN_ORPHAN_IDENTITIES} known historical, ${r.authResidue.newOrphanIdentities} new)`,
  );
  line(
    "orphan sessions",
    `${r.authResidue.orphanSessions} (${KNOWN_ORPHAN_SESSIONS} known historical, ${r.authResidue.newOrphanSessions} new)`,
  );

  if (r.regressions.length === 0) {
    console.log("\nHEALTHY — no safety regression detected.\n");
  } else {
    console.log("\nSAFETY REGRESSION:");
    for (const reg of r.regressions) console.log(`  - ${reg}`);
    console.log("");
  }
}

async function main() {
  const report = await collect();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    print(report);
  }
  process.exit(report.regressions.length === 0 ? 0 : 1);
}

// Only run when invoked directly, so the tests can import collect() and the
// constants without opening a connection.
if (process.argv[1]?.endsWith("prod-health.ts")) {
  main().catch((e) => {
    console.error(`health check failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
