/**
 * Demo company importer — the recovery plan: delete exactly the one demo
 * company, and refuse everything else.
 *
 *   npx tsx tooling/demo-company/cleanup.ts --env=test|production               # preview
 *   npx tsx tooling/demo-company/cleanup.ts --env=... --confirm=<phrase>         # delete
 *
 * Five refusals stand between this and a mistake:
 *
 *   1. The environment guard: the lab guard for test (which refuses production)
 *      or the importer's own production guard (which demands its phrase).
 *   2. Only organisations carrying THIS brand's marker are candidates. The
 *      H33 lab's `h33.pilot_lab` and the 006A factory's `demo.simulation`
 *      are different keys and are never touched.
 *   3. The candidate must be exactly ONE organisation, and its company key
 *      must be the demo company's. Two candidates, or an unexpected key,
 *      refuse.
 *   4. The confirmation phrase must name the operation and the project.
 *   5. The marker is re-checked INSIDE the delete transaction.
 *
 * What it deletes: every row in every `org_id` table for that organisation,
 * then the organisation, then the fictional logins on the reserved domain.
 * What it never deletes: the site owner's real login. Its address is not on
 * the reserved domain, so the pattern cannot match it; its membership in the
 * demo company goes with the organisation's rows, and nothing else about it
 * is touched.
 */
import { setActiveBrand, isMarkerOf } from "../pilot-lab/brand";
import { DEMO_BRAND } from "./brand";
import { RIMAL } from "./company";
import { loadLabEnv, type LabEnv } from "../pilot-lab/guard";
import { loadProductionEnv } from "./guard";
import { openOwner, type Sql } from "../pilot-lab/db";
import { adminClient } from "./provision";
import { cleanupPhrase, emailPatternOf } from "./manifest";

setActiveBrand(DEMO_BRAND);
const BRAND = DEMO_BRAND;
const COMPANY = RIMAL;

const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const ENV = (arg("env") ?? "test") as "test" | "production";
const confirm = arg("confirm") ?? "";

function loadEnv(): LabEnv {
  return ENV === "production" ? loadProductionEnv(arg("production-phrase")) : loadLabEnv();
}

type Marked = { org_id: string; name: string; company_key: string; seed_version: string };

async function markedOrgs(sql: Sql): Promise<Marked[]> {
  const rows = (await sql`
    select s.org_id::text as org_id, o.name, s.value
    from public.app_settings s join public.org o on o.id = s.org_id
    where s.key = ${BRAND.markerKey}
    order by o.created_at
  `) as unknown as Array<{ org_id: string; name: string; value: unknown }>;
  return rows
    .filter((r) => isMarkerOf(BRAND, r.value))
    .map((r) => {
      const v = (typeof r.value === "string" ? JSON.parse(r.value) : r.value) as {
        company_key: string;
        seed_version: string;
      };
      return {
        org_id: r.org_id,
        name: r.name,
        company_key: v.company_key,
        seed_version: v.seed_version,
      };
    })
    .filter((r) => r.seed_version === BRAND.seedVersion);
}

async function main() {
  const env = loadEnv();
  const sql = openOwner(env);
  const phrase = cleanupPhrase(env.ref);
  const pattern = emailPatternOf(BRAND, COMPANY.key);
  try {
    const marked = await markedOrgs(sql);
    console.log(`${BRAND.title} cleanup — ${ENV} project ${env.ref} — seed ${BRAND.seedVersion}`);
    console.log(`organisations carrying ${BRAND.markerKey}: ${marked.length}`);

    const problems: string[] = [];
    if (marked.length === 0)
      problems.push(`nothing carries the ${BRAND.markerKey} marker for this seed version`);
    if (marked.length > 1)
      problems.push(
        `more than one marked organisation (${marked.length}) — this tool deletes exactly one`,
      );
    for (const m of marked)
      if (m.company_key !== COMPANY.key)
        problems.push(
          `marked organisation ${m.org_id} has company key ${m.company_key}, not ${COMPANY.key}`,
        );

    // Belt and braces: a candidate must not ALSO carry another factory's marker.
    for (const m of marked) {
      const [other] = (await sql`
        select count(*)::int as n from public.app_settings
        where org_id = ${m.org_id} and key in ('h33.pilot_lab', 'demo.simulation')
      `) as unknown as Array<{ n: number }>;
      if (other!.n) problems.push(`${m.org_id} also carries another factory's marker — refusing`);
    }

    const tables = (await sql`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'org_id'
    `) as unknown as Array<{ table_name: string }>;
    const SAFE = /^[a-z_][a-z0-9_]*$/;
    for (const m of marked) {
      let rows = 0;
      for (const { table_name } of tables) {
        if (!SAFE.test(table_name)) continue;
        const [r] = (await sql.unsafe(
          `select count(*)::int as n from public.${table_name} where org_id = $1`,
          [m.org_id] as never[],
        )) as unknown as Array<{ n: number }>;
        rows += r!.n;
      }
      const [u] = (await sql`
        select count(*)::int as n from auth.users where email like ${pattern}
      `) as unknown as Array<{ n: number }>;
      console.log(
        `  ${m.company_key.padEnd(8)} ${m.org_id}  "${m.name}"  ${rows.toLocaleString()} rows, ${u!.n} fictional logins (${pattern})`,
      );
    }

    if (!confirm) {
      console.log(`\nPREVIEW ONLY. Nothing was deleted.`);
      if (problems.length) {
        console.log("A real run would refuse:");
        for (const p of problems) console.log(`  - ${p}`);
      } else {
        console.log(
          `A real run would delete exactly this organisation, its rows, and its fictional logins — never the owner's real login.`,
        );
      }
      console.log(`To delete: --confirm=${phrase}`);
      return;
    }
    if (confirm !== phrase)
      throw new Error(`refusing: the confirmation phrase must be exactly ${phrase}`);
    if (problems.length)
      throw new Error(`refusing:\n${problems.map((p) => `  - ${p}`).join("\n")}`);

    const orgId = marked[0]!.org_id;
    await sql.begin(async (tx) => {
      const [re] = (await tx`
        select count(*)::int as n from public.app_settings
        where org_id = ${orgId} and key = ${BRAND.markerKey}
      `) as unknown as Array<{ n: number }>;
      if (re!.n !== 1) throw new Error(`refusing inside the transaction: ${orgId} lost its marker`);
      await tx.unsafe("set local session_replication_role = replica");
      const script = [
        ...tables
          .map((t) => t.table_name)
          .filter((t) => SAFE.test(t))
          .map((t) => `delete from public."${t}" where org_id = '${orgId}'::uuid;`),
        `delete from public.org where id = '${orgId}'::uuid;`,
      ].join("\n");
      await tx.unsafe(script);
      await tx.unsafe("set local session_replication_role = default");
    });

    // The fictional logins, by the reserved-domain pattern only.
    const admin = adminClient(env);
    const users = (await sql`
      select id::text as id from auth.users where email like ${pattern}
    `) as unknown as Array<{ id: string }>;
    let removed = 0;
    for (const u of users) {
      await sql`delete from public.user_profile where id = ${u.id}`;
      const res = await admin.auth.admin.deleteUser(u.id);
      if (res.error) await sql`delete from auth.users where id = ${u.id}`;
      removed++;
    }
    const left = await markedOrgs(sql);
    console.log(
      `\ndeleted organisation ${orgId} and ${removed} fictional logins; ${left.length} marked organisations remain`,
    );
  } finally {
    await sql.end();
  }
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
