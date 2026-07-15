/**
 * The two-org bleed harness (doc 10 #11 — "the package's single most important
 * test"). Every org-scoped entity is seeded in Org A AND Org B; then for every
 * org-scoped table we prove, in Org A's ctx, that Org B's rows are invisible
 * (while confirming via the owner connection that Org B's rows really exist, so
 * the isolation is real, not vacuous). Tables Org A cannot read at all (no grant)
 * pass by construction. A registry-completeness guard fails if any org-scoped
 * table lacks a seeder — so a new tenant table cannot ship without a bleed check.
 *
 * Scope (S0 flat tenancy — every tenant table carries its OWN org_id):
 *  - Coverage is enumerated from tables that HAVE an org_id column (review m3). A
 *    future child table scoped only via a parent FK (no own org_id) would not be
 *    enumerated here and must register its own bleed coverage when introduced.
 *  - afterAll cleanup deletes in FK-TOPOLOGICAL order (children before parents),
 *    derived from pg_constraint — S1 introduced inter-tenant-table FKs
 *    (daily_report→job→job_preset, employee_terms/hr→employee→team), which made
 *    the earlier alphabetical teardown (review m6 note) come due.
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
  // CRITICAL (review CM1): seed BOTH orgs' user-keyed rows under the SAME user
  // (userA — Org A's ctx user). Then a cross-org user-keyed row (orgB, userA) can
  // ONLY be hidden from Org A's ctx by the org_id predicate, never by user
  // scoping — so a regression dropping org_id from a user-keyed policy is caught.
  await seedOrg(owner, orgA, userA, userA);
  await seedOrg(owner, orgB, userB, userA);
}, 120_000);

/** Order org-scoped tables children-first from the FK graph (pg_constraint). */
async function fkTopologicalOrder(tables: string[]): Promise<string[]> {
  const fks = (await owner`
    select c.relname as child, p.relname as parent
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_class p on p.oid = k.confrelid
    join pg_namespace n on n.oid = c.relnamespace
    where k.contype = 'f' and n.nspname = 'public'`) as unknown as Array<{
    child: string;
    parent: string;
  }>;
  const inScope = new Set(tables);
  const childrenOf = new Map<string, string[]>();
  for (const { child, parent } of fks) {
    if (child !== parent && inScope.has(child) && inScope.has(parent)) {
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child]);
    }
  }
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (t: string) => {
    if (ordered.includes(t) || visiting.has(t)) return;
    visiting.add(t);
    for (const child of childrenOf.get(t) ?? []) visit(child); // children first
    visiting.delete(t);
    ordered.push(t);
  };
  for (const t of tables) visit(t);
  return ordered;
}

afterAll(async () => {
  const tables = await fkTopologicalOrder(await orgScopedTables());
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

// Tables a tenant genuinely cannot read (no SELECT grant) — the ONLY tables
// allowed to take the 42501 branch. Any OTHER unreadable table fails loudly
// rather than silently skipping its bleed check (review, refuted-material fix).
const NO_TENANT_READ = new Set<string>([
  "domain_event",
  // S9: the raw provider webhook inbox and the ops reconciliation log are platform-internal —
  // a tenant reads subscription changes via its own audit log, not these.
  "subscription_event",
  "reconciliation",
]);

describe("two-org bleed sweep (every org-scoped table is org-pure)", () => {
  it("Org A never sees Org B's rows AND does see its own, in every org-scoped table", async () => {
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

      // As Org A: zero rows that are NOT Org A's (isolation — catches Org B,
      // null-org, or any-other-org leak, not just a literal orgB match, review
      // m5) AND >0 own rows (liveness — guards against a broken-closed deny-all
      // policy passing vacuously). Tables with no SELECT grant raise 42501 —
      // allowed ONLY if on the allowlist.
      const result = await withCtx(ctxOf(orgA, userA), (tx) =>
        tx.execute(
          sql`select
                count(*) filter (where org_id = ${orgA})::int as a,
                count(*) filter (where org_id is distinct from ${orgA})::int as foreign
              from ${sql.raw(`public.${table}`)}`,
        ),
      ).then(
        (r) => ({ ok: true as const, rows: r as unknown as Array<{ a: number; foreign: number }> }),
        (e: unknown) => ({ ok: false as const, err: e }),
      );

      if (!result.ok) {
        const code = (result.err as { code?: string; cause?: { code?: string } }).cause?.code;
        expect(code, `unexpected error reading ${table}`).toBe("42501");
        expect(NO_TENANT_READ.has(table), `${table} is unreadable but not allowlisted`).toBe(true);
        continue;
      }
      expect(result.rows[0]!.foreign, `Org A saw non-Org-A rows in ${table} (BLEED)`).toBe(0);
      expect(
        result.rows[0]!.a,
        `Org A cannot see its OWN rows in ${table} — RLS may be broken-closed`,
      ).toBeGreaterThan(0);
    }
    // 240s: the sweep grew with the add-on model (org_addon seeder + tables) and runs at the tail
    // of the full hosted suite where pooler latency stacks — 120s flaked there while passing in
    // isolation. The cap only bounds a hang; the assertions carry the correctness.
  }, 240_000);
});
