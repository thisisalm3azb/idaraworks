/**
 * H22A — listJobs pages correctly ABOVE the driver's 1,000-row boundary.
 *
 * The read used to have no bound at all, then a ceiling, and neither could
 * reach row 1,001. A ceiling is not paging: it stops at a number and says
 * nothing, so the rows past it are simply gone. This seeds more than a thousand
 * jobs in one organization and proves every one of them is reachable, that the
 * filtered total is honest, and that paging does not weaken tenant or role
 * scoping.
 *
 * The seed is written directly rather than through createJobFromPreset: the
 * subject is the READ, and 1,200 rows through the full create path would take
 * minutes and prove nothing extra about paging.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { listJobs } from "@/modules/jobs/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";

/** Comfortably past the 1,000-row cap that used to swallow rows in silence. */
const SEEDED = 1_205;

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h22a-paging",
});

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h22a-${label}-${run}@example.com`}, '{"full_name":"H22A"}'::jsonb, now(), now())`;
}

beforeAll(async () => {
  await seedUser(userA, "a");
  await seedUser(userB, "b");
  orgA = await createOrgForUser(userA, {
    name: "H22A Paging A",
    country: "AE",
    baseCurrency: "AED",
  });
  orgB = await createOrgForUser(userB, {
    name: "H22A Paging B",
    country: "AE",
    baseCurrency: "AED",
  });
  await markFixtureOrg(owner, orgA, "h22a-jobs-paging", run);
  await markFixtureOrg(owner, orgB, "h22a-jobs-paging", run);

  // One multi-row insert. created_at descends with i so the ordering the query
  // uses is deterministic and a page boundary is a known place.
  await owner`
    insert into public.job (org_id, reference, name, status_key, status_category, created_by,
                            created_at, due_date)
    select ${orgA},
           'PG-' || lpad(i::text, 5, '0'),
           case when i % 7 = 0 then 'Needle ' || i else 'Job ' || i end,
           'draft', case when i % 3 = 0 then 'active' else 'draft' end,
           ${userA},
           now() - (i || ' seconds')::interval,
           case when i % 3 = 0 then current_date - 5 else null end
    from generate_series(1, ${SEEDED}) as i`;

  // One row in the other organization, to prove isolation survives paging.
  await owner`
    insert into public.job (org_id, reference, name, status_key, status_category, created_by)
    values (${orgB}, 'OTHER-1', 'Other org job', 'draft', 'draft', ${userB})`;
}, 300_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 180_000);

describe("every row is reachable past the 1,000-row boundary", () => {
  it("reports the true total, not the page size", { timeout: 240_000 }, async () => {
    const { rows, total, hasMore } = await listJobs(ctxOf(orgA, userA), "owner", { limit: 50 });
    expect(rows).toHaveLength(50);
    expect(total, "the total must count the whole filtered set").toBe(SEEDED);
    expect(hasMore).toBe(true);
  });

  it(
    "walks the entire set page by page with no gaps or repeats",
    { timeout: 600_000 },
    async () => {
      const seen = new Set<string>();
      const page = 200;
      let offset = 0;
      let guard = 0;
      for (;;) {
        const { rows, hasMore } = await listJobs(ctxOf(orgA, userA), "owner", {
          limit: page,
          offset,
        });
        for (const r of rows) {
          expect(seen.has(r.id), `row ${r.reference} appeared on two pages`).toBe(false);
          seen.add(r.id);
        }
        if (!hasMore) break;
        offset += page;
        expect(++guard, "paging did not terminate").toBeLessThan(50);
      }
      // The whole point: row 1,001 and beyond exist and were reached.
      expect(seen.size).toBe(SEEDED);
    },
  );

  it("reaches rows that live beyond the old ceiling", { timeout: 240_000 }, async () => {
    // Ordering is created_at desc and the seed descends with i, so the LAST
    // seeded row sorts last. Ask for it directly by offset.
    const { rows } = await listJobs(ctxOf(orgA, userA), "owner", {
      limit: 5,
      offset: SEEDED - 5,
    });
    expect(rows).toHaveLength(5);
    expect(rows[rows.length - 1]!.reference).toBe(`PG-${String(SEEDED).padStart(5, "0")}`);
  });

  it("the last page reports no more", { timeout: 240_000 }, async () => {
    const { rows, hasMore } = await listJobs(ctxOf(orgA, userA), "owner", {
      limit: 100,
      offset: SEEDED - 10,
    });
    expect(rows).toHaveLength(10);
    expect(hasMore).toBe(false);
  });

  it("an offset past the end is empty rather than an error", { timeout: 240_000 }, async () => {
    const { rows, hasMore } = await listJobs(ctxOf(orgA, userA), "owner", {
      limit: 50,
      offset: SEEDED + 500,
    });
    expect(rows).toEqual([]);
    expect(hasMore).toBe(false);
  });
});

describe("search and filters narrow the SET, not the page", () => {
  it(
    "search matches across the whole table, not the first page",
    { timeout: 240_000 },
    async () => {
      // Every 7th row is a Needle, so matches are spread far past row 1,000.
      const expected = Math.floor(SEEDED / 7);
      const { rows, total } = await listJobs(ctxOf(orgA, userA), "owner", {
        search: "Needle",
        limit: 10,
      });
      expect(total).toBe(expected);
      expect(rows.every((r) => r.name.startsWith("Needle"))).toBe(true);
    },
  );

  it(
    "search finds a single row that sits beyond the old ceiling",
    { timeout: 240_000 },
    async () => {
      const { rows, total } = await listJobs(ctxOf(orgA, userA), "owner", {
        search: "PG-01199",
        limit: 10,
      });
      expect(total).toBe(1);
      expect(rows[0]!.reference).toBe("PG-01199");
    },
  );

  it(
    "the overdue filter counts the overdue SET, spanning the boundary",
    { timeout: 240_000 },
    async () => {
      // Every 3rd row is active with a past due date; the rest have no date.
      const expected = Math.floor(SEEDED / 3);
      const asOf = new Date().toISOString().slice(0, 10);
      const { rows, total } = await listJobs(ctxOf(orgA, userA), "owner", {
        overdueAsOf: asOf,
        limit: 25,
      });
      expect(total, "filtering happens in SQL over every row").toBe(expected);
      expect(rows).toHaveLength(25);
      // And the rule matches jobIsOverdue: open, dated, and the date has passed.
      expect(rows.every((r) => typeof r.dueDate === "string" && r.dueDate < asOf)).toBe(true);
      expect(rows.every((r) => r.statusCategory === "active")).toBe(true);
    },
  );

  it("a filter that matches nothing returns an honest zero", { timeout: 240_000 }, async () => {
    const { rows, total, hasMore } = await listJobs(ctxOf(orgA, userA), "owner", {
      search: "no-such-job-anywhere",
    });
    expect(rows).toEqual([]);
    expect(total).toBe(0);
    expect(hasMore).toBe(false);
  });
});

describe("paging does not weaken scoping", () => {
  it("another organization's rows never appear on any page", { timeout: 240_000 }, async () => {
    const { total } = await listJobs(ctxOf(orgA, userA), "owner", { limit: 1 });
    expect(total, "org B's row must not be counted").toBe(SEEDED);

    const otherWay = await listJobs(ctxOf(orgB, userB), "owner", { limit: 500 });
    expect(otherWay.total).toBe(1);
    expect(otherWay.rows[0]!.reference).toBe("OTHER-1");
  });

  it(
    "a foreman sees only assigned work, however deep the paging goes",
    { timeout: 240_000 },
    async () => {
      // None of the seeded rows is assigned to anyone, so the foreman's set is
      // empty at every offset rather than merely on the first page.
      const first = await listJobs(ctxOf(orgA, userA), "foreman", { limit: 100 });
      expect(first.total).toBe(0);
      expect(first.rows).toEqual([]);

      const deep = await listJobs(ctxOf(orgA, userA), "foreman", { limit: 100, offset: 1000 });
      expect(deep.rows).toEqual([]);
    },
  );
});
