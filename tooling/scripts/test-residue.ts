/**
 * Test-fixture residue report (H21.1 Part E).
 *
 * Integration suites create organizations in a real database. When a run is
 * killed mid-flight no teardown hook runs, so orgs survive. This reports what
 * survived, and it is DRY-RUN ONLY: it never deletes anything. Deletion is a
 * separate, reviewed decision.
 *
 * How disposable data is identified — deliberately NOT by name. `public.org.name`
 * has no uniqueness constraint and nothing stops a real tenant from being called
 * "S9 Org", so a name pattern is used only to SURFACE a candidate, never to
 * conclude anything. Every candidate is scored against four independent kinds of
 * evidence and the report states which ones it has:
 *
 *   1. marker    — app_settings['test.fixture'].is_test_fixture, written by the
 *                  suite itself (tests/integration/helpers.ts markFixtureOrg).
 *   2. emails    — EVERY member's email sits on a reserved test domain.
 *   3. name      — the org name matches a known fixture name exactly.
 *   4. no_business — the org holds no records a real customer would have created
 *                  (customers, invoices, payments, quotes, work).
 *
 * An org is reported as CONFIRMED FIXTURE only with the marker, or with all three
 * of the remaining kinds. Anything else is reported as NEEDS REVIEW and is
 * explicitly called out as unsafe to delete unattended.
 *
 * Usage:
 *   npx tsx tooling/scripts/test-residue.ts
 *   npx tsx tooling/scripts/test-residue.ts --json
 */
import { config } from "dotenv";
import postgres from "postgres";

config({ path: [".env.local", ".env"], quiet: true });

/** Domains that only ever appear in fixtures. Never a real customer's domain. */
const TEST_EMAIL_DOMAINS = ["@example.com", "@journey.invalid", "@test.local"];
/** LIKE patterns for the above, passed as a parameter — never interpolated. */
const TEST_EMAIL_PATTERNS = TEST_EMAIL_DOMAINS.map((d) => `%${d}`);

/** Exact org names known to be created by suites. Surfacing aid only. */
const FIXTURE_NAMES = [
  "S7 Org",
  "S7 Org B",
  "S8 Org",
  "S9 Org",
  "S9 Imp Org",
  "S9 Wk Org",
  "S9 PC Org",
  "S9 RO Org",
  "H21 A",
  "Storage Harness Org",
  "H21 B",
];

const MARKER_KEY = "test.fixture";
/**
 * The seeded demo organizations carry their own marker (tooling/simulation).
 * They use example.com logins and so would otherwise look like fixtures, but
 * they hold deliberate business data and are NOT residue. Naming them here keeps
 * them out of the candidate lists entirely instead of leaving five permanent
 * "needs review" rows that train the reader to skim past the section.
 */
const SIMULATION_MARKER_KEY = "demo.simulation";

type Row = {
  id: string;
  name: string;
  created_at: string;
  has_marker: boolean;
  marker_suite: string | null;
  is_simulation: boolean;
  members: number;
  test_emails: number;
  real_emails: number;
  customers: number;
  invoices: number;
  payments: number;
  quotes: number;
  jobs: number;
};

async function main() {
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL missing — fill .env.local");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const rows = (await sql`
      select
        o.id::text as id,
        o.name,
        to_char(o.created_at, 'YYYY-MM-DD HH24:MI') as created_at,
        (s.value ->> 'is_test_fixture') = 'true' as has_marker,
        s.value ->> 'suite' as marker_suite,
        sim.org_id is not null as is_simulation,
        (select count(*)::int from public.membership m where m.org_id = o.id) as members,
        (select count(*)::int from public.membership m
           join auth.users u on u.id = m.user_id
          where m.org_id = o.id and u.email like any(${TEST_EMAIL_PATTERNS})
        ) as test_emails,
        (select count(*)::int from public.membership m
           join auth.users u on u.id = m.user_id
          where m.org_id = o.id and not (u.email like any(${TEST_EMAIL_PATTERNS}))
        ) as real_emails,
        (select count(*)::int from public.customer c where c.org_id = o.id) as customers,
        (select count(*)::int from public.invoice i where i.org_id = o.id) as invoices,
        (select count(*)::int from public.payment p where p.org_id = o.id) as payments,
        (select count(*)::int from public.quote q where q.org_id = o.id) as quotes,
        (select count(*)::int from public.job j where j.org_id = o.id) as jobs
      from public.org o
      left join public.app_settings s on s.org_id = o.id and s.key = ${MARKER_KEY}
      left join public.app_settings sim
        on sim.org_id = o.id and sim.key = ${SIMULATION_MARKER_KEY}
      order by o.created_at
    `) as unknown as Row[];

    const confirmed: Row[] = [];
    const review: Row[] = [];
    const simulation: Row[] = [];
    /** Everything that is not a candidate at all, with the reason it is not. */
    const notCandidates: Array<Row & { why: string }> = [];
    for (const r of rows) {
      // A deliberately seeded demo org is never test residue, whatever it looks like.
      if (r.is_simulation) {
        simulation.push(r);
        continue;
      }
      const byName = FIXTURE_NAMES.includes(r.name);
      const allTestEmails = r.members > 0 && r.real_emails === 0 && r.test_emails === r.members;
      const noBusiness =
        r.customers === 0 && r.invoices === 0 && r.payments === 0 && r.quotes === 0;
      // The marker is the org saying so itself. Otherwise every other kind of
      // evidence must agree — a name alone never decides anything.
      if (r.has_marker) confirmed.push(r);
      else if (byName && allTestEmails && noBusiness) confirmed.push(r);
      else if (byName || (allTestEmails && r.members > 0)) review.push(r);
      else {
        // Every organization must be accounted for, or the totals do not add up
        // and a reader cannot tell whether something was overlooked.
        notCandidates.push({
          ...r,
          why:
            r.real_emails > 0
              ? `${r.real_emails} real login(s) — a live organization`
              : r.members === 0
                ? "no members at all"
                : "no fixture evidence of any kind",
        });
      }
    }

    if (process.argv.includes("--json")) {
      console.log(
        JSON.stringify(
          { confirmed, review, simulation, notCandidates, scanned: rows.length },
          null,
          2,
        ),
      );
      return;
    }

    const line = (r: Row) => {
      const evidence = [
        r.has_marker ? `marker(${r.marker_suite ?? "?"})` : null,
        FIXTURE_NAMES.includes(r.name) ? "name" : null,
        r.members > 0 && r.real_emails === 0 ? "test-emails" : null,
        r.customers === 0 && r.invoices === 0 && r.payments === 0 && r.quotes === 0
          ? "no-business"
          : null,
      ].filter(Boolean);
      console.log(
        `  ${r.created_at}  ${r.name.padEnd(16)} ${r.id}\n` +
          `        evidence: ${evidence.join(", ") || "NONE"}\n` +
          `        rows: members=${r.members} work=${r.jobs} customers=${r.customers} ` +
          `invoices=${r.invoices} payments=${r.payments} quotes=${r.quotes}` +
          (r.real_emails > 0 ? `  <-- ${r.real_emails} NON-TEST email(s)` : ""),
      );
    };

    console.log(`scanned ${rows.length} organizations\n`);
    console.log(`CONFIRMED FIXTURES (${confirmed.length}) — safe to remove:`);
    if (confirmed.length === 0) console.log("  none");
    confirmed.forEach(line);
    console.log(`\nNEEDS REVIEW (${review.length}) — do NOT delete unattended:`);
    if (review.length === 0) console.log("  none");
    review.forEach(line);
    console.log(`\nSEEDED DEMO, not residue (${simulation.length}) — leave alone:`);
    if (simulation.length === 0) console.log("  none");
    simulation.forEach((r) => console.log(`  ${r.name} ${r.id}`));

    console.log(`\nNOT CANDIDATES (${notCandidates.length}) — live or empty, never in scope:`);
    if (notCandidates.length === 0) console.log("  none");
    notCandidates.forEach((r) => console.log(`  ${r.name.padEnd(24)} ${r.id}  (${r.why})`));

    // The four groups must account for every organization scanned. If they do
    // not, the report is hiding something and says so rather than looking tidy.
    const tallied = confirmed.length + review.length + simulation.length + notCandidates.length;
    console.log(
      `\ntally: ${confirmed.length} confirmed + ${review.length} review + ` +
        `${simulation.length} demo + ${notCandidates.length} not-candidates = ${tallied} ` +
        `of ${rows.length} scanned`,
    );
    if (tallied !== rows.length) {
      console.log(`  !! ${rows.length - tallied} organization(s) UNACCOUNTED FOR`);
      process.exitCode = 1;
    }
    console.log(
      "\nThis command never deletes. Removing anything above is a separate, reviewed decision.",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
