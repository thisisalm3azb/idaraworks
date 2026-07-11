/**
 * The migration harness + wrong-context database-block tests
 * (S0 checklist §4 steps 6–7; doc 10 items 1, 2, 15-partial, 18).
 * Runs against real tables from migration 0001.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb, closeAppDb, withCtx, type Ctx } from "@/platform/tenancy";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const orgA = randomUUID();
const orgB = randomUUID();
const user = randomUUID();
const ctxA: Ctx = { orgId: orgA, userId: user, costPrivileged: false, requestId: "t-a" };

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
    // existence-only gate. Assert the doc 10 #1 template on every policy.
    const policies = await owner`
      select tablename, policyname, roles, cmd, qual, with_check
      from pg_policies
      where schemaname = 'public'`;
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) {
      const roles = (p.roles as string[]) ?? [];
      expect(roles, `policy ${p.tablename}.${p.policyname} roles = ${roles}`).toEqual(["app_user"]);
      expect(p.qual, `policy ${p.tablename}.${p.policyname} has no USING predicate`).toMatch(
        /current_org_id/,
      );
      expect(
        p.with_check,
        `policy ${p.tablename}.${p.policyname} has no WITH CHECK predicate`,
      ).toMatch(/current_org_id/);
      expect(p.cmd, `policy ${p.tablename}.${p.policyname} does not cover ALL`).toBe("ALL");
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
      { orgId: orgB, userId: user, costPrivileged: false, requestId: "t-b" },
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

    const outside = (await appDb().execute(
      sql`select app.current_org_id()::text as org`,
    )) as unknown as Array<{ org: string | null }>;
    expect(outside[0]!.org).toBeNull();
  });

  it("malformed ctx never reaches set_config", async () => {
    await expect(
      withCtx(
        { orgId: "not-a-uuid", userId: user, costPrivileged: false, requestId: "x" },
        async () => {
          /* unreachable */
        },
      ),
    ).rejects.toThrow(/not a UUID/);
  });
});
