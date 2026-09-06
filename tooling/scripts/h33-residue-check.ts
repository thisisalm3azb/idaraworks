/**
 * H33 zero-residue proof, read-only, against PRODUCTION.
 *
 * The Pilot Lab is deliberately RETAINED in the isolated test project — five
 * synthetic companies the owner is meant to walk through by hand. That is not
 * residue; it is the deliverable. Residue means H33 data in PRODUCTION, and
 * that is what this script proves is absent.
 *
 * Everything the lab writes is traceable three ways, so all three are checked:
 * the marker row (`app_settings.key = 'h33.pilot_lab'`), the reserved login
 * domain (`@pilot-lab.invalid`), and the five organisation names. It also
 * checks the seeder's own checkpoint keys, since a partial run would leave
 * those behind even if it wrote nothing else.
 *
 * Read-only by construction: one SELECT, no transaction, no writes, and the
 * production-only guard refuses to run against anything but production so the
 * proof cannot be quietly taken from the wrong database.
 */
import "./load-env";
import postgres from "postgres";
import { targetsOnlyProductionProject } from "../../tests/integration/guard-env";
import { COMPANIES } from "../pilot-lab/companies";
import { MARKER_KEY, EMAIL_DOMAIN, SEED_VERSION } from "../pilot-lab/marker";

async function main() {
  const target = targetsOnlyProductionProject();
  if (!target.ok) {
    throw new Error(`production only:\n${target.problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  const names = COMPANIES.map((c) => c.nameEn);
  const sql = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
  try {
    const [r] = (await sql`
      select
        (select count(*)::int from public.app_settings
          where key = ${MARKER_KEY}) as marker_rows,
        (select count(*)::int from public.app_settings
          where key like ${"h33.checkpoint.%"}) as checkpoint_rows,
        (select count(*)::int from public.app_settings
          where key like ${"h33.%"}) as any_h33_setting,
        (select count(*)::int from auth.users
          where email like ${"%@" + EMAIL_DOMAIN}) as lab_logins,
        (select count(*)::int from public.org
          where name = any(${names}::text[])) as lab_orgs,
        (select count(*)::int from public.org) as orgs,
        (select count(*)::int from auth.users) as users,
        (select count(*)::int from public.customer) as customers,
        (select count(*)::int from public.invoice) as invoices,
        (select count(*)::int from public.journal_entry) as journal_entries
    `) as unknown as Array<Record<string, number>>;

    const residueKeys = [
      "marker_rows",
      "checkpoint_rows",
      "any_h33_setting",
      "lab_logins",
      "lab_orgs",
    ];
    let residue = 0;
    for (const [k, v] of Object.entries(r!)) {
      const isResidue = residueKeys.includes(k) && v > 0;
      if (isResidue) residue += v;
      const flag = residueKeys.includes(k) ? (v > 0 ? "RESIDUE" : "ok     ") : "count  ";
      console.log(`${flag} ${k.padEnd(18)} ${v}`);
    }
    console.log(
      `\nseed version ${SEED_VERSION}; H33 residue rows in production: ${residue} (must be 0)`,
    );
    console.log(
      `production business counts (untouched): ${r!.orgs} orgs, ${r!.users} users, ` +
        `${r!.customers} customers, ${r!.invoices} invoices, ${r!.journal_entries} journal entries`,
    );
    if (residue !== 0) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
