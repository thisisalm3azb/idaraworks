/**
 * H30 Part F — paging past the row boundaries, with enough rows to mean it.
 *
 * The existing paging fixture stops at 130 rows, which is below every boundary
 * worth crossing: a page size, a default limit, and the 1,000-row ceiling that
 * PostgREST imposes on Supabase's REST API. IdaraWorks reads through a direct
 * postgres connection rather than PostgREST, so that ceiling does not apply
 * here — but "it does not apply" is a claim, and this is the test that makes it
 * one somebody checked rather than one somebody assumed.
 *
 * What a paged list must never do, and what is asserted below:
 *   - lose a row between pages (a gap),
 *   - return a row twice (a duplicate),
 *   - stop early while claiming there is no more,
 *   - or silently cap the set at a round number.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { listStockLevels } from "@/modules/inventory/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";

/** Deliberately past 1,000: the boundary is the point of the test. */
const ITEM_COUNT = 1150;

const ctx = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h30-scale",
});

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h30-scale-${run}@example.com`}, '{"full_name":"H30"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H30 Scale", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h30-pagination-scale", run);

  const unitA = randomUUID();
  await owner`
    insert into public.unit_of_measure
      (id, org_id, code, name_en, name_ar, dimension, factor_to_base, is_base)
    values (${unitA}, ${orgA}, 'EA', 'Each', 'حبة', 'count', 1, true)`;

  // One statement, not 1,150 round-trips. SKUs are zero-padded so the cursor's
  // lexicographic ordering is also the numeric one — otherwise "SKU-10" sorts
  // before "SKU-9" and a gap would look like a paging bug that is really a
  // fixture bug.
  const ids = Array.from({ length: ITEM_COUNT }, () => randomUUID());
  const skus = Array.from({ length: ITEM_COUNT }, (_, i) => `SKU-${String(i).padStart(5, "0")}`);
  await owner`
    insert into public.item (id, org_id, sku, name, category_key, unit, item_type, base_unit_id)
    select x.id, ${orgA}, x.sku, 'Scale item', 'general', 'ea', 'inventory', ${unitA}
    from unnest(${ids}::uuid[], ${skus}::text[]) as x(id, sku)`;
}, 180_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  await closeAppDb();
  await owner.end({ timeout: 5 });
});

describe("paging a list larger than every boundary", () => {
  it("walks the whole set with no gaps, no duplicates and no silent cap", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    // Bounded so a paging bug that never advances fails as a loop guard rather
    // than hanging the suite until the runner kills it.
    while (pages < 100) {
      const page = await listStockLevels(ctx(), "owner", { cursor, limit: 200 });
      pages += 1;
      for (const r of page.rows) seen.push(r.sku);
      if (!page.hasMore) break;
      expect(page.nextCursor, "hasMore was true but no cursor was given").toBeTruthy();
      cursor = page.nextCursor!;
    }

    expect(pages).toBeLessThan(100);
    // Every item, exactly once.
    expect(seen).toHaveLength(ITEM_COUNT);
    expect(new Set(seen).size).toBe(ITEM_COUNT);
    // And in the order the cursor promises, which is what makes it resumable.
    expect([...seen].sort()).toEqual(seen);
    // Specifically past the ceiling that would have truncated a REST read.
    expect(seen).toContain("SKU-00999");
    expect(seen).toContain("SKU-01000");
    expect(seen).toContain(`SKU-${String(ITEM_COUNT - 1).padStart(5, "0")}`);
  }, 300_000);

  it("a search filters the whole dataset, not only the first page", async () => {
    // The defect this guards against: filtering rows already fetched, so a match
    // on row 1,100 is invisible because the search never reached it.
    const page = await listStockLevels(ctx(), "owner", { search: "SKU-01149", limit: 50 });
    expect(page.rows.map((r) => r.sku)).toContain("SKU-01149");
  }, 120_000);

  it("the page size is bounded — a caller cannot ask for everything at once", async () => {
    // An unbounded read of a tenant table is how a slow page becomes an outage.
    const page = await listStockLevels(ctx(), "owner", { limit: 100_000 });
    expect(page.rows.length).toBeLessThanOrEqual(200);
    expect(page.hasMore).toBe(true);
  }, 120_000);
});
