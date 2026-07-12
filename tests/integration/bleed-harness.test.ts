/**
 * The two-org bleed harness (doc 10 #11 — "the package's single most important
 * test"). Every org-scoped entity is seeded in Org A AND Org B; then for every
 * org-scoped table we prove, in Org A's ctx, that Org B's rows are invisible
 * (while confirming via the owner connection that Org B's rows really exist, so
 * the isolation is real, not vacuous). Tables Org A cannot read at all (no grant)
 * pass by construction. A registry-completeness guard fails if any org-scoped
 * table lacks a seeder — so a new tenant table cannot ship without a bleed check.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { SEEDERS, seedOrg } from "../../tooling/scripts/seed-two-orgs";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";

async function seedAuthUser(id: string, email: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${email}, '{"full_name":"x"}'::jsonb, now(), now())`;
}

/** Every public base table that carries an org_id — the tenant surface. */
async function orgScopedTables(): Promise<string[]> {
  const rows = await owner`
    select c.relname as name from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped)
    order by c.relname`;
  return rows.map((r) => r.name as string);
}

beforeAll(async () => {
  await seedAuthUser(userA, `bleed-a-${run}@example.com`);
  await seedAuthUser(userB, `bleed-b-${run}@example.com`);
  orgA = await createOrgForUser(userA, { name: "Bleed A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "Bleed B", country: "SA", baseCurrency: "SAR" });
  await seedOrg(owner, orgA, userA);
  await seedOrg(owner, orgB, userB);
}, 120_000);

afterAll(async () => {
  const tables = await orgScopedTables();
  for (const org of [orgA, orgB].filter(Boolean)) {
    for (const t of tables) {
      await owner.unsafe(`delete from public.${t} where org_id = $1`, [org]);
    }
    await owner`delete from public.org where id = ${org}`;
  }
  await owner`delete from public.user_profile where id = any(${[userA, userB]}::uuid[])`;
  await owner`delete from auth.users where id = any(${[userA, userB]}::uuid[])`;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "bleed",
});

describe("registry completeness (a new tenant table must register a seeder)", () => {
  it("every org-scoped table has a seeder", async () => {
    const tables = await orgScopedTables();
    const missing = tables.filter((t) => !(t in SEEDERS));
    expect(missing, `org-scoped tables without a seeder: ${missing.join(", ")}`).toEqual([]);
    // …and no stale seeders for tables that no longer exist.
    const stale = Object.keys(SEEDERS).filter((t) => !tables.includes(t));
    expect(stale, `seeders for non-existent tables: ${stale.join(", ")}`).toEqual([]);
  });
});

describe("two-org bleed sweep (every org-scoped table is org-pure)", () => {
  it("Org A never sees Org B's rows, in any org-scoped table", async () => {
    const tables = await orgScopedTables();
    expect(tables.length).toBeGreaterThanOrEqual(15);

    for (const table of tables) {
      // Org B genuinely has rows here (owner bypasses RLS) — so the isolation
      // check below is meaningful, not vacuous.
      const bTruthRows = (await owner.unsafe(
        `select count(*)::int as n from public.${table} where org_id = $1`,
        [orgB],
      )) as unknown as Array<{ n: number }>;
      expect(bTruthRows[0]?.n, `seeder produced no Org B row for ${table}`).toBeGreaterThan(0);

      // As Org A: zero Org B rows must be visible. Tables A cannot read at all
      // (no SELECT grant, e.g. domain_event) raise 42501 — max isolation, a pass.
      const result = await withCtx(ctxOf(orgA, userA), (tx) =>
        tx.execute(
          sql`select count(*) filter (where org_id = ${orgB})::int as b
              from ${sql.raw(`public.${table}`)}`,
        ),
      ).then(
        (r) => ({ ok: true as const, rows: r as unknown as Array<{ b: number }> }),
        (e: unknown) => ({ ok: false as const, err: e }),
      );

      if (!result.ok) {
        const code = (result.err as { code?: string; cause?: { code?: string } }).cause?.code;
        expect(code, `unexpected error reading ${table}`).toBe("42501"); // unreadable → no bleed
        continue;
      }
      expect(result.rows[0]!.b, `Org A saw Org B rows in ${table} (BLEED)`).toBe(0);
    }
  }, 120_000);

  it("reads are not broken-closed: Org A sees its OWN rows in the base tables", async () => {
    // Guards the sweep above from passing vacuously (RLS denying everything to
    // everyone). These tables are unconditionally readable by any org member.
    const own = await withCtx(ctxOf(orgA, userA), (tx) =>
      tx.execute(sql`
        select
          (select count(*) from public.company where org_id = ${orgA})::int as company,
          (select count(*) from public.role_definition where org_id = ${orgA})::int as roles,
          (select count(*) from public.membership where org_id = ${orgA})::int as members`),
    );
    const r = (own as unknown as Array<{ company: number; roles: number; members: number }>)[0]!;
    expect(r.company).toBe(1);
    expect(r.roles).toBe(7);
    expect(r.members).toBeGreaterThanOrEqual(1);
  });
});
