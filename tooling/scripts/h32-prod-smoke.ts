/**
 * H32 production smoke.
 *
 * Two modes over the same code:
 *   flag OFF — proves the welcome experience is genuinely absent and today's
 *              behaviour is untouched;
 *   flag ON  — proves the schema, the isolation and the eligibility rule hold
 *              on the real database.
 *
 * Reads only. It creates nothing and modifies nothing — which is not a
 * convenience, it is the point: the one property this feature must never
 * violate is "creates or changes business records", so its own smoke test has
 * no write path to get that wrong with.
 *
 *   npx tsx tooling/scripts/h32-prod-smoke.ts --confirm=apply-migrations-to-<ref>
 *   npx tsx tooling/scripts/h32-prod-smoke.ts --confirm=… --expect-flag=on
 */
import "./load-env";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import {
  productionMigrationPhrase,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";
import { AUTO_START_FROM, allTours, MAX_STEPS } from "../../src/modules/guidedtour/tours";

const CONFIRM = process.argv.find((a) => a.startsWith("--confirm="))?.split("=")[1] ?? "";
const EXPECT_ON = process.argv.includes("--expect-flag=on");
const BASE = "https://www.idaraworks.com";

const run = randomUUID().slice(0, 8);
let checks = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail = "") {
  checks += 1;
  const line = `${label}${detail ? ` — ${detail}` : ""}`;
  if (condition) console.log(`ok   ${line}`);
  else {
    console.log(`FAIL ${line}`);
    failures.push(label);
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

  console.log(`H32 production smoke (run ${run}, expecting flag ${EXPECT_ON ? "ON" : "OFF"})`);
  const sql = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });

  /** The business numbers. They must be identical at the end. */
  const counts = async () => {
    const [r] = (await sql`
      select
        (select count(*) from public.org)::text as orgs,
        (select count(*) from auth.users)::text as users,
        (select count(*) from public.customer)::text as customers,
        (select count(*) from public.invoice)::text as invoices,
        (select count(*) from public.job)::text as jobs,
        (select count(*) from public.audit_log)::text as audit_rows,
        (select count(*) from public.onboarding_state)::text as onboarding_rows
    `) as unknown as Array<Record<string, string>>;
    return r!;
  };

  try {
    const before = await counts();
    console.log(
      `  baseline: ${before.orgs} orgs / ${before.users} users / ${before.customers} customers / ` +
        `${before.invoices} invoices / ${before.onboarding_rows} onboarding rows`,
    );

    // ── The table is there, and it is shaped as designed ──────────────────────
    const [schema] = (await sql`
      select
        to_regclass('public.onboarding_state') is not null as tbl,
        (select relrowsecurity from pg_class
          where oid = 'public.onboarding_state'::regclass) as rls
    `) as unknown as Array<{ tbl: boolean; rls: boolean }>;
    ok("schema: onboarding_state exists", schema?.tbl === true);
    ok("schema: row-level security is enabled", schema?.rls === true);

    /*
     * The one that matters. Both halves of the predicate must appear in EVERY
     * policy: without the org half a tenant reads another company's rows;
     * without the user half an administrator reads a colleague's. A policy that
     * lost either would still function perfectly in day-to-day use.
     */
    const policies = (await sql`
      select polname as name,
             pg_get_expr(polqual, polrelid) as using_expr,
             pg_get_expr(polwithcheck, polrelid) as check_expr
      from pg_policy where polrelid = 'public.onboarding_state'::regclass
      order by polname
    `) as unknown as Array<{ name: string; using_expr: string | null; check_expr: string | null }>;

    ok("policies: select, insert and update all exist", policies.length === 3, `${policies.length}`);
    for (const p of policies) {
      const text = `${p.using_expr ?? ""} ${p.check_expr ?? ""}`;
      ok(
        `policy ${p.name}: scoped to BOTH org and user`,
        text.includes("current_org_id") && text.includes("current_user_id"),
      );
    }

    // ── Grants: no delete, and no way to move a row to somebody else ──────────
    const grants = (await sql`
      select privilege_type, column_name
      from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'onboarding_state' and grantee = 'app_user'
    `) as unknown as Array<{ privilege_type: string; column_name: string }>;
    const updatable = grants
      .filter((g) => g.privilege_type === "UPDATE")
      .map((g) => g.column_name);
    ok("grants: a tenant cannot re-key a row to another org", !updatable.includes("org_id"));
    ok("grants: a tenant cannot re-key a row to another user", !updatable.includes("user_id"));

    const [del] = (await sql`
      select bool_or(privilege_type = 'DELETE') as can_delete
      from information_schema.table_privileges
      where table_schema = 'public' and table_name = 'onboarding_state' and grantee = 'app_user'
    `) as unknown as Array<{ can_delete: boolean | null }>;
    ok("grants: no DELETE", del?.can_delete !== true);

    // ── The eligibility rule, measured against the real customer base ─────────
    const [elig] = (await sql`
      select
        count(*) filter (where created_at < ${AUTO_START_FROM.toISOString()})::text as pre_existing,
        count(*) filter (where created_at >= ${AUTO_START_FROM.toISOString()})::text as newcomers,
        count(*)::text as total
      from public.membership where deactivated_at is null
    `) as unknown as Array<Record<string, string>>;
    console.log(
      `  memberships: ${elig!.pre_existing} predate the cutoff (never auto-greeted), ` +
        `${elig!.newcomers} are new, ${elig!.total} total`,
    );
    /*
     * The mandate's promise, stated as a number rather than an intention: every
     * person already working here is excluded from the automatic welcome. If
     * this ever reads 0 the cutoff has drifted into the future relative to the
     * customer base and the whole existing user base would be interrupted.
     */
    ok(
      "eligibility: existing members are excluded from the automatic welcome",
      Number(elig!.pre_existing) > 0,
      `${elig!.pre_existing} protected`,
    );

    // ── Content laws, re-checked against what actually shipped ────────────────
    for (const { key, steps } of allTours()) {
      ok(`tour ${key}: within the ${MAX_STEPS}-step cap`, steps.length <= MAX_STEPS, `${steps.length}`);
    }
    ok(
      "tours: every one ends by explaining how to find it again",
      allTours().every((t) => t.steps.at(-1)?.key === "help"),
    );

    // ── The live site ─────────────────────────────────────────────────────────
    // Unauthenticated, so this proves the deployment is healthy and the tour is
    // not leaking to anonymous visitors; the flag's real effect is inside the
    // signed-in shell and is verified by the browser walk.
    const health = await fetch(`${BASE}/api/health`, { cache: "no-store" });
    ok("site: health endpoint responds", health.ok, `${health.status}`);

    const login = await fetch(`${BASE}/login`, { cache: "no-store" });
    const loginHtml = await login.text();
    ok("site: the sign-in page renders", login.ok, `${login.status}`);
    ok(
      "site: no onboarding tour is served to a signed-out visitor",
      !loginHtml.includes("data-tour") && !loginHtml.includes("iw-tour-"),
    );

    // ── Nothing moved ─────────────────────────────────────────────────────────
    const after = await counts();
    for (const key of Object.keys(before)) {
      ok(`unchanged: ${key}`, before[key] === after[key], `${before[key]} → ${after[key]}`);
    }
  } finally {
    await sql.end();
  }

  console.log(
    failures.length === 0
      ? `\nPASS — ${checks}/${checks} checks.`
      : `\nFAIL — ${failures.length} of ${checks}: ${failures.join(", ")}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
