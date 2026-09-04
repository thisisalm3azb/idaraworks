/**
 * H31 zero-residue proof, read-only.
 *
 * H31's tests run on the isolated test project and its production smoke creates
 * nothing, so "zero residue" is checkable directly rather than inferred: no
 * fixture organisation, and no row at all in either table H31 introduced.
 */
import "./load-env";
import postgres from "postgres";
import { targetsOnlyProductionProject } from "../../tests/integration/guard-env";

async function main() {
  const target = targetsOnlyProductionProject();
  if (!target.ok) {
    throw new Error(`production only:\n${target.problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  const sql = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
  try {
    const [r] = (await sql`
      select
        (select count(*)::int from public.org where name like 'H31%') as h31_orgs,
        (select count(*)::int from auth.users where email like '%h31%') as h31_users,
        (select count(*)::int from public.tenant_host) as tenant_hosts,
        (select count(*)::int from public.org_app_brand) as app_brands,
        (select count(*)::int from public.tenant_host
          where host like 'bleed-%' or host like 'h31-%') as fixture_hosts,
        (select count(*)::int from public.org) as orgs,
        (select count(*)::int from auth.users) as users,
        (select count(*)::int from public.customer) as customers,
        (select count(*)::int from public.invoice) as invoices
    `) as unknown as Array<Record<string, number>>;

    const residueKeys = ["h31_orgs", "h31_users", "tenant_hosts", "app_brands", "fixture_hosts"];
    let residue = 0;
    for (const [k, v] of Object.entries(r!)) {
      const isResidue = residueKeys.includes(k) && v > 0;
      if (isResidue) residue += v;
      console.log(`${isResidue ? "RESIDUE" : "ok     "} ${k.padEnd(14)} ${v}`);
    }
    console.log(`\nH31 residue rows: ${residue} (must be 0)`);
    console.log(
      `business counts: ${r!.orgs} orgs, ${r!.users} users, ${r!.customers} customers, ${r!.invoices} invoices`,
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
