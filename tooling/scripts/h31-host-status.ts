/**
 * H31 — read, and deliberately change, a company hostname's status.
 *
 * The one tool that can make a hostname live. It follows the house rules for a
 * production-changing script exactly:
 *
 *   - it identifies production POSITIVELY and inspects the explicit `.ok`
 *     verdict, never the verdict object;
 *   - it is read-only unless `--set` is given;
 *   - a write against production additionally demands an exact intent phrase;
 *   - it prints what it is about to do before doing it.
 *
 *   npx tsx tooling/scripts/h31-host-status.ts --host=acme.idaraworks.com
 *   npx tsx tooling/scripts/h31-host-status.ts --host=… --set=active \
 *     --confirm=activate-host-in-<project-ref>
 */
import "./load-env";
import postgres from "postgres";
import {
  PRODUCTION_PROJECT_REF,
  referencedProjectRefs,
  targetsOnlyProductionProject,
  type EnvSnapshot,
} from "../../tests/integration/guard-env";

const arg = (name: string): string =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=") ?? "";

const HOST = arg("host").trim().toLowerCase();
const SET = arg("set").trim();
const REASON = arg("reason").trim();
const CONFIRM = arg("confirm").trim();

const VALID = ["pending", "active", "failed", "released"];

function confirmPhraseFor(ref: string): string {
  return `activate-host-in-${ref}`;
}

async function main() {
  if (!HOST) throw new Error("--host is required");

  const refs = referencedProjectRefs(process.env as EnvSnapshot);
  if (refs.length !== 1) {
    throw new Error(
      `Expected exactly one Supabase project in the environment, found ${refs.length || "none"}` +
        (refs.length ? `: ${refs.join(", ")}` : "") +
        ".\nThis tool refuses an environment it cannot name.",
    );
  }
  const ref = refs[0]!;
  const production = targetsOnlyProductionProject();
  // The explicit verdict, never the object: reading it as a boolean is how a
  // guard becomes either vacuous or universal (H29's lesson, H30's audit).
  const isProduction = production.ok === true && ref === PRODUCTION_PROJECT_REF;
  console.log(`target project: ${ref}${isProduction ? "  ** PRODUCTION **" : ""}`);

  if (SET) {
    if (!VALID.includes(SET)) throw new Error(`--set must be one of ${VALID.join(", ")}`);
    if (isProduction && CONFIRM !== confirmPhraseFor(ref)) {
      throw new Error(
        `Refusing to change a hostname in PRODUCTION without explicit intent.\n` +
          `Re-run with --confirm=${confirmPhraseFor(ref)}`,
      );
    }
  }

  const sql = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
  try {
    const rows = (await sql`
      select th.id::text as id, th.host, th.kind, th.status,
             o.name as org_name, th.org_id::text as org_id,
             to_char(th.created_at, 'YYYY-MM-DD HH24:MI') as created_at,
             to_char(th.verified_at, 'YYYY-MM-DD HH24:MI') as verified_at,
             to_char(th.claimable_after, 'YYYY-MM-DD HH24:MI') as claimable_after,
             th.failed_reason
      from public.tenant_host th
      join public.org o on o.id = th.org_id
      where th.host = ${HOST}
      order by th.created_at
    `) as unknown as Array<Record<string, string | null>>;

    if (rows.length === 0) {
      console.log(`\nno rows for ${HOST} — nothing claims this hostname.`);
      return;
    }
    console.log(`\n${rows.length} row(s) for ${HOST}:`);
    for (const r of rows) {
      console.log(`  ${r.status?.padEnd(9)} ${r.kind?.padEnd(10)} ${r.org_name} (${r.org_id})`);
      console.log(
        `      created ${r.created_at}` +
          (r.verified_at ? `  verified ${r.verified_at}` : "") +
          (r.claimable_after ? `  claimable after ${r.claimable_after}` : "") +
          (r.failed_reason ? `  reason: ${r.failed_reason}` : ""),
      );
    }

    if (!SET) {
      console.log("\nread-only. pass --set=<status> to change it.");
      return;
    }

    /*
     * The status change runs through app.tenant_host_set_status, which asserts
     * a platform operator. Running it as the owner here is the deliberate
     * break-glass path for an operator at a terminal, and it is why this script
     * demands the intent phrase that the function itself cannot ask for.
     */
    console.log(`\nsetting ${HOST} -> ${SET}${REASON ? ` (${REASON})` : ""}`);
    await sql`
      update public.tenant_host
      set status = ${SET},
          verified_at = case when ${SET} = 'active' then now() else verified_at end,
          released_at = case when ${SET} = 'released' then now() else released_at end,
          claimable_after = case when ${SET} = 'released' then now() + interval '90 days'
                                 else claimable_after end,
          failed_reason = case when ${SET} = 'failed' then ${REASON || null} else null end,
          verification_evidence = coalesce(verification_evidence, '{}'::jsonb)
            || jsonb_build_object('operator_cli', jsonb_build_object(
                 'at', now(), 'set', ${SET}, 'reason', ${REASON || null})),
          updated_at = now()
      where host = ${HOST} and status in ('pending', 'active', 'failed')`;

    const [after] = (await sql`
      select status from public.tenant_host where host = ${HOST}
      order by updated_at desc limit 1`) as unknown as Array<{ status: string }>;
    console.log(`done. status is now: ${after?.status ?? "(gone)"}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
