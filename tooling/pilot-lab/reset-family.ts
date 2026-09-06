/**
 * H33 Pilot Lab — undo ONE family for ONE company, so a half-applied family can
 * be re-run cleanly.
 *
 *   npx tsx tooling/pilot-lab/reset-family.ts <company> <family> --confirm
 *
 * A family inserts table by table. If it fails on the fourth table, the first
 * three are already in — and if the fix changes the ids the family derives (a
 * shared ordinal counter shifts when a generator mints more rows), a re-run
 * writes NEW rows beside the stale ones instead of colliding with them. That is
 * the one way this lab can end up with data nobody planned.
 *
 * Three refusals stand between this and a mistake:
 *
 *   1. The same guard as everything else: the isolated test project only.
 *   2. The organisation must carry the H33 marker at this seed version.
 *   3. The family must have NO checkpoint. A checkpointed family completed;
 *      undoing it would leave the families that depend on it pointing at rows
 *      that no longer exist, and that is a cleanup, not a reset.
 */
import { loadLabEnv } from "./guard";
import { openOwner } from "./db";
import { findLabOrg } from "./provision";
import { getCheckpoint } from "./checkpoint";
import { COMPANIES } from "./companies";
import { FAMILIES } from "./families";
import { SEED_VERSION } from "./marker";

const [companyKey, familyKey] = process.argv.slice(2);
const CONFIRM = process.argv.includes("--confirm");

/** The tables each family owns, read from the family's own exported list. */
async function tablesOf(family: string): Promise<string[]> {
  const mod: Record<string, unknown> = await import(`./families/${family}`);
  const key = Object.keys(mod).find((k) => /_TABLES$/.test(k));
  if (!key) throw new Error(`family ${family} exports no <NAME>_TABLES list`);
  return [...(mod[key] as readonly string[])];
}

async function main() {
  const company = COMPANIES.find((c) => c.key === companyKey);
  const family = FAMILIES.find((f) => f.key === familyKey);
  if (!company || !family) {
    throw new Error(
      `usage: reset-family.ts <${COMPANIES.map((c) => c.key).join("|")}> <${FAMILIES.map((f) => f.key).join("|")}> --confirm`,
    );
  }

  const env = loadLabEnv();
  const sql = openOwner(env);
  try {
    const orgId = await findLabOrg(sql, company.key);
    if (!orgId) throw new Error(`${company.key} is not provisioned in ${env.ref}`);

    const cp = await getCheckpoint(sql, orgId, family.key);
    if (cp) {
      throw new Error(
        `${company.key}/${family.key} is checkpointed — it completed. Reset is for a family that failed part way; use the cleanup for a whole company.`,
      );
    }

    // Children before parents: the families list their tables in insert order.
    const tables = (await tablesOf(family.key)).reverse();
    console.log(
      `H33 reset — ${company.key} (${orgId}) family ${family.key} in ${env.ref}, seed ${SEED_VERSION}`,
    );
    let total = 0;
    const counts: Array<[string, number]> = [];
    for (const t of tables) {
      if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw new Error(`refusing unsafe table name ${t}`);
      const [r] = (await sql.unsafe(
        `select count(*)::int as n from public.${t} where org_id = $1`,
        [orgId] as never[],
      )) as unknown as Array<{ n: number }>;
      if (r!.n > 0) counts.push([t, r!.n]);
      total += r!.n;
    }
    for (const [t, n] of counts) console.log(`  ${t.padEnd(28)} ${n}`);
    console.log(`  ${"total".padEnd(28)} ${total}`);

    if (!CONFIRM) {
      console.log("\npreview only — pass --confirm to delete these rows");
      return;
    }
    if (total === 0) {
      console.log("\nnothing to delete");
      return;
    }
    await sql.begin(async (tx) => {
      // The marker is re-checked inside the transaction, not just before it.
      const [m] = (await tx`
        select count(*)::int as n from public.app_settings
        where org_id = ${orgId} and key = 'h33.pilot_lab'
      `) as unknown as Array<{ n: number }>;
      if (m!.n !== 1) throw new Error("the organisation does not carry the H33 marker");
      for (const [t] of counts) {
        await tx.unsafe(`delete from public.${t} where org_id = $1`, [orgId] as never[]);
      }
    });
    console.log(`\ndeleted ${total} rows; ${company.key}/${family.key} can be seeded again`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
