/**
 * H30 LB-1 — the law that decides what a destructive script may delete.
 *
 * The defect this pins down was not a crash. `s7-cleanup.ts` selected its
 * victims by COMPLEMENT: every organisation not in a two-entry hard-coded
 * allow-list. With 40 organisations in production and 2 protected, one
 * `--apply` after the first pilot signup would have deleted paying customers,
 * their users and their logins — correctly, according to the code.
 *
 * So the tests below are about one property above all others: an organisation
 * the classifier does not RECOGNISE must be kept, never deleted.
 */
import { describe, expect, it } from "vitest";
import {
  classifyOrg,
  FIXTURE_NAMES,
  TEST_EMAIL_DOMAINS,
  type OrgEvidence,
} from "../../tooling/fixtures/evidence";

const base: OrgEvidence = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "Some Real Company LLC",
  created_at: "2026-01-01 00:00",
  has_marker: false,
  marker_suite: null,
  is_simulation: false,
  members: 3,
  test_emails: 0,
  real_emails: 3,
  customers: 12,
  invoices: 40,
  payments: 30,
  quotes: 8,
  jobs: 15,
};

const org = (over: Partial<OrgEvidence> = {}): OrgEvidence => ({ ...base, ...over });

describe("what may be deleted", () => {
  it("a real tenant is never deletable", () => {
    expect(classifyOrg(org()).classification).toBe("live");
  });

  it("the suite's own marker is sufficient", () => {
    const c = classifyOrg(org({ has_marker: true, marker_suite: "h30" }));
    expect(c.classification).toBe("confirmed_fixture");
    expect(c.reason).toContain("h30");
  });

  it("three independent kinds of evidence are sufficient", () => {
    const c = classifyOrg(
      org({
        name: FIXTURE_NAMES[0]!,
        members: 2,
        test_emails: 2,
        real_emails: 0,
        customers: 0,
        invoices: 0,
        payments: 0,
        quotes: 0,
      }),
    );
    expect(c.classification).toBe("confirmed_fixture");
  });

  it("a fixture NAME alone is never enough — the name column has no uniqueness constraint", () => {
    // A real customer is free to call themselves "S9 Org". Deleting on a name
    // match alone is precisely the class of mistake this module exists to stop.
    const c = classifyOrg(org({ name: FIXTURE_NAMES[0]! }));
    expect(c.classification).not.toBe("confirmed_fixture");
  });

  it("test emails alone are not enough while business records exist", () => {
    const c = classifyOrg(
      org({ members: 2, test_emails: 2, real_emails: 0, name: "Not A Known Fixture" }),
    );
    expect(c.classification).toBe("needs_review");
  });

  it("one real login makes an organisation live however else it looks", () => {
    const c = classifyOrg(
      org({
        name: FIXTURE_NAMES[0]!,
        members: 3,
        test_emails: 2,
        real_emails: 1,
        customers: 0,
        invoices: 0,
        payments: 0,
        quotes: 0,
      }),
    );
    expect(c.classification).toBe("live");
    expect(c.reason).toContain("real login");
  });

  it("a seeded demo organisation is kept, not swept up as residue", () => {
    const c = classifyOrg(org({ is_simulation: true, has_marker: true }));
    expect(c.classification).toBe("simulation");
  });

  it("AN ORGANISATION THE CLASSIFIER DOES NOT RECOGNISE IS KEPT", () => {
    // The property that matters most. A shape nobody anticipated — no members,
    // no records, no marker, an unfamiliar name — must be safe by default.
    const c = classifyOrg(
      org({
        name: "Something Nobody Anticipated",
        members: 0,
        test_emails: 0,
        real_emails: 0,
        customers: 0,
        invoices: 0,
        payments: 0,
        quotes: 0,
        jobs: 0,
      }),
    );
    expect(c.classification).toBe("live");
  });

  it("no reserved test domain is a domain a real business could hold", () => {
    // `.invalid` and `.local` are reserved by RFC; example.com is IANA's.
    for (const d of TEST_EMAIL_DOMAINS) {
      expect(d).toMatch(/@(example\.com|[a-z]+\.(invalid|local))$/);
    }
  });
});

describe("the report is exhaustive", () => {
  it("every organisation lands in exactly one classification", () => {
    const shapes: OrgEvidence[] = [
      org(),
      org({ has_marker: true }),
      org({ is_simulation: true }),
      org({ name: FIXTURE_NAMES[1]! }),
      org({ members: 0, real_emails: 0, customers: 0, invoices: 0, payments: 0, quotes: 0 }),
      org({ members: 1, test_emails: 1, real_emails: 0 }),
    ];
    const seen = shapes.map((s) => classifyOrg(s).classification);
    expect(seen).toHaveLength(shapes.length);
    for (const c of seen) {
      expect(["confirmed_fixture", "needs_review", "simulation", "live"]).toContain(c);
    }
  });
});
