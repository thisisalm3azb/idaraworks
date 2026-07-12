/**
 * The migration harness + wrong-context database-block tests
 * (S0 checklist §4 steps 6–7; doc 10 items 1, 2, 15-partial, 18).
 * Runs against real tables from migration 0001.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, createAppDb, withCtx, type Ctx } from "@/platform/tenancy";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const orgA = randomUUID();
const orgB = randomUUID();
const user = randomUUID();
const ctxA: Ctx = {
  orgId: orgA,
  userId: user,
  costPrivileged: false,
  pricePrivileged: false,
  requestId: "t-a",
};

beforeAll(async () => {
  await owner`insert into public.org (id, name, country, base_currency)
    values (${orgA}, 'Harness Org A', 'AE', 'AED'), (${orgB}, 'Harness Org B', 'SA', 'SAR')`;
});

afterAll(async () => {
  await owner`delete from public.app_settings where org_id in (${orgA}, ${orgB})`;
  await owner`delete from public.org where id in (${orgA}, ${orgB})`;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("migration harness (every tenant table is defended)", () => {
  it("every public base table has RLS enabled AND at least one policy", async () => {
    const tables = await owner`
      select c.relname as name, c.relrowsecurity as rls,
             (select count(*) from pg_policies p
               where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`;
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      expect(t.rls, `table public.${t.name} has RLS disabled`).toBe(true);
      expect(Number(t.policies), `table public.${t.name} has no policy`).toBeGreaterThan(0);
    }
  });

  it("app_user is NOBYPASSRLS and not superuser", async () => {
    const [role] = await owner`
      select rolbypassrls, rolsuper from pg_roles where rolname = 'app_user'`;
    expect(role).toBeDefined();
    expect(role!.rolbypassrls).toBe(false);
    expect(role!.rolsuper).toBe(false);
  });

  it("app_user has no DELETE grant on any public table (D-1.7 at grant level)", async () => {
    const rows = await owner`
      select c.relname as name,
             has_table_privilege('app_user', c.oid, 'DELETE') as can_delete
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`;
    for (const r of rows) {
      expect(r.can_delete, `app_user can DELETE from public.${r.name}`).toBe(false);
    }
  });

  it("every policy has the correct SHAPE, not just existence (review minor #6)", async () => {
    // A wide-open `using (true)` or `TO public` policy would pass an
    // existence-only gate. Assert the doc 10 #1 template on every policy:
    // scoped TO app_user, covering ALL, with USING and WITH CHECK predicates
    // that reference a tenancy GUC (current_org_id OR — for the resolver's
    // bootstrap tables user_profile/membership/sign_in_log — current_user_id).
    const TENANCY_GUC = /current_org_id|current_user_id/;
    // Classify by the POLICY, not the column: a tenant policy references a
    // tenancy GUC in its predicate (org keys on `id`, not `org_id`, so a column
    // check would misclassify it). Crucially the predicate may live in USING
    // (SELECT/UPDATE/DELETE) OR in WITH CHECK (INSERT-only policies have a null
    // qual — their tenancy scoping is entirely in with_check). A policy whose
    // NEITHER clause references a GUC is global platform-reference data
    // (entitlement catalogue, plans) — legitimate, but must be read-only.
    const policies = await owner`
      select tablename, policyname, roles, cmd, qual, with_check
      from pg_policies
      where schemaname = 'public'`;
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) {
      const roles = (p.roles as string[]) ?? [];
      expect(roles, `policy ${p.tablename}.${p.policyname} roles = ${roles}`).toEqual(["app_user"]);
      const where = `${p.tablename}.${p.policyname}`;
      const qualHasGuc = TENANCY_GUC.test(String(p.qual ?? ""));
      const checkHasGuc = TENANCY_GUC.test(String(p.with_check ?? ""));
      if (p.cmd === "INSERT") {
        // No USING clause (qual is null); tenancy scoping lives entirely in
        // WITH CHECK, which must pin the tenant so no cross-org row can be written.
        expect(checkHasGuc, `${where} INSERT WITH CHECK not tenancy-scoped`).toBe(true);
      } else if (p.cmd === "ALL" || p.cmd === "UPDATE") {
        // Read AND write: USING must scope the read to the tenant AND WITH CHECK
        // must pin the write — a `using (true)` here would be a cross-tenant hole.
        expect(qualHasGuc, `${where} USING not tenancy-scoped (read escape)`).toBe(true);
        expect(checkHasGuc, `${where} WITH CHECK not tenancy-scoped (write escape)`).toBe(true);
      } else {
        // SELECT: either a tenant-scoped read (USING references a GUC) or global
        // platform-reference data — which must be SELECT-only + no write grant.
        if (!qualHasGuc) {
          expect(p.cmd, `reference table ${p.tablename} policy must be SELECT-only`).toBe("SELECT");
          const [priv] = await owner`
            select has_table_privilege('app_user', ('public.' || ${p.tablename})::regclass, 'INSERT') as w`;
          expect(priv!.w, `reference table ${p.tablename} must not be writable by app_user`).toBe(
            false,
          );
        }
      }
    }
  });

  it("every WRITABLE tenant table's WITH CHECK pins the org (no write escape)", async () => {
    // Reads may widen to co-members (user_profile) or own-membership (org), but
    // every INSERT/UPDATE path must confine rows to the active org — except the
    // append-only sign_in_log, whose pre-org login events legitimately allow a
    // null org (asserted separately by its own insert behaviour).
    const ORG_WRITE_TABLES = [
      "org",
      "company",
      "app_settings",
      "org_holiday_calendar",
      "currency_rate_default",
      "role_definition",
      "membership",
      "membership_invite",
    ];
    const policies = await owner`
      select tablename, with_check from pg_policies where schemaname = 'public'`;
    for (const name of ORG_WRITE_TABLES) {
      const p = policies.find((x) => x.tablename === name);
      expect(p, `no policy for ${name}`).toBeDefined();
      expect(p!.with_check, `${name} WITH CHECK must pin current_org_id`).toMatch(/current_org_id/);
    }
  });

  it("built-in Supabase roles (anon/authenticated) hold no table privileges", async () => {
    const rows = await owner`
      select c.relname as name, r.rolname as role,
             has_table_privilege(r.rolname, c.oid, 'SELECT') as can_select
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join (select rolname from pg_roles where rolname in ('anon','authenticated')) r
      where n.nspname = 'public' and c.relkind = 'r'`;
    for (const r of rows) {
      expect(r.can_select, `${r.role} can SELECT from public.${r.name}`).toBe(false);
    }
  });

  it("no public function is executable by PUBLIC/anon/authenticated (0016 sweep)", async () => {
    // Functions default to PUBLIC EXECUTE; the 0016 sweep revokes it. has_function_
    // privilege for anon/authenticated also picks up any lingering PUBLIC grant
    // (PUBLIC applies to every role). App helpers live in schema `app`, not here.
    const rows = await owner`
      select p.proname as name, r.rolname as role,
             has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can_exec
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (select rolname from pg_roles where rolname in ('anon','authenticated')) r
      where n.nspname = 'public'`;
    for (const r of rows) {
      expect(r.can_exec, `${r.role} can EXECUTE public.${r.name}()`).toBe(false);
    }
  });

  it("PUBLIC holds no privilege on any public table (0016 sweep)", async () => {
    // A PUBLIC grant would show up as `has_table_privilege('public', ...)`.
    const rows = await owner`
      select c.relname as name,
             has_table_privilege('public', c.oid, 'SELECT') as pub_select,
             has_table_privilege('public', c.oid, 'INSERT') as pub_insert
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`;
    for (const r of rows) {
      expect(r.pub_select, `PUBLIC can SELECT public.${r.name}`).toBe(false);
      expect(r.pub_insert, `PUBLIC can INSERT public.${r.name}`).toBe(false);
    }
  });

  it("app.migrations tracking table is invisible to app_user", async () => {
    const [priv] = await owner`
      select has_table_privilege('app_user', 'app.migrations', 'SELECT') as can_read`;
    expect(priv!.can_read).toBe(false);
  });
});

describe("wrong-context blocks happen in the DATABASE (doc 10 #1)", () => {
  it("ctx A sees exactly its own org row", async () => {
    const rows = await withCtx(ctxA, async (tx) => {
      return (await tx.execute(
        sql`select id::text as id, name from public.org`,
      )) as unknown as Array<{
        id: string;
        name: string;
      }>;
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(orgA);
  });

  it("ctx A cannot update org B (0 rows affected, silently filtered)", async () => {
    const updated = await withCtx(ctxA, async (tx) => {
      return (await tx.execute(
        sql`update public.org set name = 'hijacked' where id = ${orgB} returning id`,
      )) as unknown as Array<{ id: string }>;
    });
    expect(updated.length).toBe(0);
    const [check] = await owner`select name from public.org where id = ${orgB}`;
    expect(check!.name).toBe("Harness Org B");
  });

  it("ctx A cannot insert settings for org B (RLS WITH CHECK rejects)", async () => {
    // Review M4: drizzle wraps driver errors in DrizzleQueryError; the Postgres
    // detail lives on .cause — assert SQLSTATE 42501 there, not on the message.
    const err = await withCtx(ctxA, async (tx) => {
      await tx.execute(
        sql`insert into public.app_settings (org_id, key, value) values (${orgB}, 'smuggle', '{}'::jsonb)`,
      );
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err, "insert was not rejected at all").toBeInstanceOf(Error);
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    expect(cause?.code, `unexpected error: ${String(err)}`).toBe("42501");
    expect(cause?.message).toMatch(/row-level security/i);
    const [n] =
      await owner`select count(*)::int as n from public.app_settings where org_id = ${orgB}`;
    expect(n!.n).toBe(0);
  });

  it("ctx A can write and read its own settings; B context cannot see them", async () => {
    await withCtx(ctxA, async (tx) => {
      await tx.execute(
        sql`insert into public.app_settings (org_id, key, value) values (${orgA}, 'greeting', '"marhaba"'::jsonb)`,
      );
    });
    const mine = await withCtx(ctxA, async (tx) => {
      return (await tx.execute(sql`select key from public.app_settings`)) as unknown as Array<{
        key: string;
      }>;
    });
    expect(mine.map((r) => r.key)).toContain("greeting");

    const theirs = await withCtx(
      {
        orgId: orgB,
        userId: user,
        costPrivileged: false,
        pricePrivileged: false,
        requestId: "t-b",
      },
      async (tx) => {
        return (await tx.execute(sql`select key from public.app_settings`)) as unknown as Array<{
          key: string;
        }>;
      },
    );
    expect(theirs.length).toBe(0);
  });

  it("app.current_org_id() is set inside withCtx and NULL outside it", async () => {
    const inside = await withCtx(ctxA, async (tx) => {
      const r = (await tx.execute(
        sql`select app.current_org_id()::text as org`,
      )) as unknown as Array<{
        org: string | null;
      }>;
      return r[0]!.org;
    });
    expect(inside).toBe(orgA);

    // Dedicated client for the no-ctx probe — the shared pool is transactions-only (A-B5).
    const fresh = createAppDb({ max: 1 });
    try {
      const outside = (await fresh.db.execute(
        sql`select app.current_org_id()::text as org`,
      )) as unknown as Array<{ org: string | null }>;
      expect(outside[0]!.org).toBeNull();
    } finally {
      await fresh.end();
    }
  });

  it("malformed ctx never reaches set_config", async () => {
    await expect(
      withCtx(
        {
          orgId: "not-a-uuid",
          userId: user,
          costPrivileged: false,
          pricePrivileged: false,
          requestId: "x",
        },
        async () => {
          /* unreachable */
        },
      ),
    ).rejects.toThrow(/not a UUID/);
  });
});
