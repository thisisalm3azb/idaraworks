/**
 * S9 fake-provider residue purge — removes ONLY synthetic test residue the org-scoped
 * s7-cleanup sweep cannot reach: platform-inbox rows with provider='fake' (the fake billing
 * provider exists only in tests/demos; it is disabled in production, so provider='fake' is
 * synthetic by construction) and orphan unprocessed outbox events whose org no longer exists.
 *
 * SAFETY: dry-run by default (pass --apply); never touches any row belonging to a live org —
 * the outbox purge is restricted to org_ids ABSENT from public.org (protected orgs therefore
 * structurally excluded); subscription_event purge additionally requires org_id IS NULL OR
 * org not in public.org. Prints exactly what it will delete before deleting.
 */
import "./load-env";
import postgres from "postgres";

const APPLY = process.argv.includes("--apply");

async function main() {
  const sql = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
  try {
    const subEvents = (await sql`
      select id::text, org_id::text, provider, provider_event_id, event_type, status
      from public.subscription_event
      where provider = 'fake'
        and (org_id is null or org_id not in (select id from public.org))
      order by received_at`) as unknown as Array<Record<string, unknown>>;
    console.log(`fake-provider subscription_event residue: ${subEvents.length}`);
    for (const r of subEvents)
      console.log(
        `  org=${r.org_id ?? "NULL"} evt=${r.provider_event_id} type=${r.event_type} status=${r.status}`,
      );

    const recon = (await sql`
      select id::text, org_id::text
      from public.reconciliation
      where org_id is null or org_id not in (select id from public.org)`) as unknown as Array<
      Record<string, unknown>
    >;
    console.log(`orphan reconciliation residue: ${recon.length}`);

    const outbox = (await sql`
      select id::text, org_id::text, name, processed_at is not null as processed
      from public.domain_event
      where org_id not in (select id from public.org)
      order by occurred_at`) as unknown as Array<Record<string, unknown>>;
    console.log(`orphan outbox (org no longer exists) residue: ${outbox.length}`);
    for (const r of outbox)
      console.log(`  org=${r.org_id} name=${r.name} processed=${r.processed}`);

    if (!APPLY) {
      console.log("\nDRY-RUN. re-run with --apply to execute.");
      return;
    }
    await sql.begin(async (tx) => {
      await tx`delete from public.subscription_event
        where provider = 'fake'
          and (org_id is null or org_id not in (select id from public.org))`;
      await tx`delete from public.reconciliation
        where org_id is null or org_id not in (select id from public.org)`;
      await tx`delete from public.domain_event
        where org_id not in (select id from public.org)`;
    });
    console.log(
      `\nAPPLIED — purged ${subEvents.length} subscription_event + ${recon.length} reconciliation + ${outbox.length} orphan outbox rows.`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
