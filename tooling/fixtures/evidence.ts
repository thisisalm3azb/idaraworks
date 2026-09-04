/**
 * H30 LB-1 — deciding whether an organisation is disposable test residue.
 *
 * This used to live inside the read-only residue REPORT, while the script that
 * actually deletes decided the opposite way round: it removed every organisation
 * except two named in a hard-coded allow-list. That inversion is safe only while
 * production contains nothing but fixtures. The moment a pilot customer signs
 * up, an allow-list complement is a customer-data destroyer, and nobody has to
 * make a mistake for it to happen — the script does exactly what it says.
 *
 * So the rule is inverted here, once, and both scripts import it:
 *
 *   an organisation is deletable only if it PROVES it is a fixture.
 *
 * Anything that cannot prove it is kept, including anything this module has
 * never heard of. A new organisation shape that nothing recognises is safe by
 * default rather than deleted by default.
 */
import type { Sql } from "postgres";

/** Domains that only ever appear in fixtures. Never a real customer's domain. */
export const TEST_EMAIL_DOMAINS = ["@example.com", "@journey.invalid", "@test.local"];
/** LIKE patterns for the above, passed as a parameter — never interpolated. */
export const TEST_EMAIL_PATTERNS = TEST_EMAIL_DOMAINS.map((d) => `%${d}`);

/** Exact organisation names known to be created by suites. A surfacing aid only:
 *  a name never decides anything on its own, because `public.org.name` has no
 *  uniqueness constraint and nothing stops a real tenant from choosing one. */
export const FIXTURE_NAMES = [
  "S7 Org",
  "S7 Org B",
  "S8 Org",
  "S9 Org",
  "S9 Imp Org",
  "S9 Wk Org",
  "S9 PC Org",
  "S9 RO Org",
  "H21 A",
  "H21 B",
  "Storage Harness Org",
];

/** The suite writing this about itself is the strongest evidence there is. */
export const MARKER_KEY = "test.fixture";
/** A deliberately seeded demo organisation is never residue, however it looks. */
export const SIMULATION_MARKER_KEY = "demo.simulation";

export type OrgEvidence = {
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

export type Classification = "confirmed_fixture" | "needs_review" | "simulation" | "live";

export type Classified = OrgEvidence & {
  classification: Classification;
  /** Why it landed where it did, in words a person can act on. */
  reason: string;
  /** The independent kinds of evidence this organisation actually carries. */
  evidence: string[];
};

/**
 * Classify one organisation from its evidence. Pure: no database, no clock, so
 * the rule can be tested exhaustively without a fixture.
 *
 * `confirmed_fixture` is the ONLY value any destructive script may act on, and
 * it is reached two ways:
 *
 *   - the organisation carries the suite's own marker; or
 *   - three independent kinds of evidence agree — a known fixture name, every
 *     member on a reserved test domain, and no business records at all.
 *
 * Everything else is `needs_review` or `live`, and both mean "do not touch".
 */
export function classifyOrg(row: OrgEvidence): Classified {
  const evidence: string[] = [];
  if (row.has_marker) evidence.push(`marker(${row.marker_suite ?? "unnamed"})`);
  const byName = FIXTURE_NAMES.includes(row.name);
  if (byName) evidence.push("known fixture name");
  const allTestEmails = row.members > 0 && row.real_emails === 0 && row.test_emails === row.members;
  if (allTestEmails) evidence.push(`all ${row.members} member(s) on a reserved test domain`);
  const noBusiness =
    row.customers === 0 && row.invoices === 0 && row.payments === 0 && row.quotes === 0;
  if (noBusiness) evidence.push("no customers, invoices, payments or quotes");

  if (row.is_simulation) {
    return {
      ...row,
      classification: "simulation",
      reason: "a deliberately seeded demo organisation — deliberate data, not residue",
      evidence,
    };
  }
  if (row.has_marker) {
    return {
      ...row,
      classification: "confirmed_fixture",
      reason: `the suite marked it itself (${row.marker_suite ?? "unnamed suite"})`,
      evidence,
    };
  }
  if (byName && allTestEmails && noBusiness) {
    return {
      ...row,
      classification: "confirmed_fixture",
      reason: "three independent kinds of evidence agree",
      evidence,
    };
  }
  if (row.real_emails > 0) {
    return {
      ...row,
      classification: "live",
      reason: `${row.real_emails} real login(s) — a live organisation`,
      evidence,
    };
  }
  if (byName || (allTestEmails && row.members > 0)) {
    return {
      ...row,
      classification: "needs_review",
      reason: "some fixture evidence, but not enough to be sure",
      evidence,
    };
  }
  return {
    ...row,
    classification: "live",
    reason: row.members === 0 ? "no members at all" : "no fixture evidence of any kind",
    evidence,
  };
}

/** The one query both the report and the cleanup run, so they cannot disagree. */
export async function readOrgEvidence(sql: Sql): Promise<OrgEvidence[]> {
  return (await sql`
    select
      o.id::text as id,
      o.name,
      to_char(o.created_at, 'YYYY-MM-DD HH24:MI') as created_at,
      coalesce((s.value ->> 'is_test_fixture') = 'true', false) as has_marker,
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
    left join public.app_settings sim on sim.org_id = o.id and sim.key = ${SIMULATION_MARKER_KEY}
    order by o.created_at
  `) as unknown as OrgEvidence[];
}
