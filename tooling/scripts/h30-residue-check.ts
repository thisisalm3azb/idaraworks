/**
 * H30 zero-residue proof, read-only.
 *
 * H30 shipped no migrations and its smoke creates nothing, so "zero residue" is
 * a claim that can be checked directly rather than inferred: no organisation
 * carrying an H30 marker, and none of the tables H30's new write paths touch
 * holding a single row in production.
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
        (select count(*)::int from public.org where name like 'H30%') as h30_orgs,
        (select count(*)::int from auth.users where email like '%h30%') as h30_users,
        (select count(*)::int from public.warehouse) as warehouses,
        (select count(*)::int from public.stock_location) as locations,
        (select count(*)::int from public.unit_of_measure) as units,
        (select count(*)::int from public.stock_movement) as movements,
        (select count(*)::int from public.org) as orgs
    `) as unknown as Array<Record<string, number>>;

    const rows = Object.entries(r!);
    let residue = 0;
    for (const [k, v] of rows) {
      const isResidue = k !== "orgs" && v > 0;
      if (isResidue) residue += v;
      console.log(`${isResidue ? "RESIDUE" : "ok     "} ${k.padEnd(12)} ${v}`);
    }
    console.log(`\nH30 residue rows: ${residue} (must be 0)`);
    console.log(`organisations in production: ${r!.orgs} (baseline before H30: 40)`);
    if (residue !== 0 || r!.orgs !== 40) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
