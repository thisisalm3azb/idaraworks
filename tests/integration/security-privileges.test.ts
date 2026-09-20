/**
 * Security review 2026-09-20 (pass two) — database privileges and the shared
 * rate-limit store (migration 0143).
 *
 * Proves, through the app role (NOBYPASSRLS) rather than the owner:
 *  - the three HR SECURITY DEFINER functions refuse an org id that is not the
 *    transaction's org (they used to trust the parameter);
 *  - operator-only functions refuse a member who is not a platform operator,
 *    and two of them cannot be reached by the app role at all;
 *  - the auth trigger still creates a profile row with its PUBLIC grant gone;
 *  - `app.rate_limit_hit` counts a fixed window shared by every connection and
 *    says when the window rolls over.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: `secpriv-${run}`,
});

async function seedAuthUser(id: string, email: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${email}, '{"full_name":"x"}'::jsonb, now(), now())`;
}

const messageOf = (err: unknown): string => {
  const e = err as { message?: string; cause?: { message?: string; code?: string } };
  return `${e.message ?? ""} | ${e.cause?.message ?? ""} | ${e.cause?.code ?? ""}`;
};

beforeAll(async () => {
  await seedAuthUser(userA, `secpriv-a-${run}@example.com`);
  await seedAuthUser(userB, `secpriv-b-${run}@example.com`);
  orgA = await createOrgForUser(userA, {
    name: `SecPriv A ${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  orgB = await createOrgForUser(userB, {
    name: `SecPriv B ${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
}, 120_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("HR functions are pinned to the transaction's organisation", () => {
  it("refuses another organisation's id under org A's context", async () => {
    const employee = randomUUID();
    for (const call of [
      sql`select app.rollup_attendance_day(${orgB}::uuid, ${employee}::uuid, current_date)`,
      sql`select app.resolve_leave_days(${orgB}::uuid, ${randomUUID()}::uuid, ${employee}::uuid, 'leave', array[current_date]::date[])`,
      sql`select app.revert_leave_days(${orgB}::uuid, ${randomUUID()}::uuid, ${employee}::uuid)`,
    ]) {
      await expect(withCtx(ctxOf(orgA, userA), (tx) => tx.execute(call))).rejects.toSatisfy(
        (err: unknown) => /organisation mismatch|42501/.test(messageOf(err)),
      );
    }
  });

  it("still serves its own organisation (the guard is invisible to the app)", async () => {
    // revert_leave_days on an unknown request touches no row and returns 0.
    const rows = (await withCtx(ctxOf(orgA, userA), (tx) =>
      tx.execute(
        sql`select app.revert_leave_days(${orgA}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid) as n`,
      ),
    )) as unknown as Array<{ n: number }>;
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it("the unguarded bodies are not reachable by the app role", async () => {
    const rows = await owner`
      select p.proname, has_function_privilege('app_user', p.oid, 'EXECUTE') as ok
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname like '%_unguarded'`;
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.ok, String(r.proname)).toBe(false);
  });
});

describe("operator-only functions", () => {
  it("refuse a member who is not a platform operator", async () => {
    for (const call of [
      sql`select app.set_org_addon(${orgA}::uuid, 'addon.members_10', 1, 'active', null, 'test')`,
      sql`select app.ai_price_book_add('openai', 'gpt-5-nano', now(), 'USD', 1, 1, null, null, null, null, 'test')`,
      sql`select app.start_impersonation(${userA}::uuid, ${orgA}::uuid, 'test', null, false)`,
    ]) {
      await expect(withCtx(ctxOf(orgA, userA), (tx) => tx.execute(call))).rejects.toBeTruthy();
    }
  });

  it("two operator-only functions nothing in the app calls are not executable by the app role", async () => {
    const rows = await owner`
      select p.proname,
             has_function_privilege('app_user', p.oid, 'EXECUTE') as app_user_ok,
             has_function_privilege('public', p.oid, 'EXECUTE') as public_ok
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname in ('set_plan_price', 'country_pack_upsert', 'set_org_addon', 'handle_new_auth_user')`;
    const byName = Object.fromEntries(rows.map((r) => [String(r.proname), r]));
    expect(byName.set_plan_price?.app_user_ok).toBe(false);
    expect(byName.country_pack_upsert?.app_user_ok).toBe(false);
    expect(byName.set_org_addon?.public_ok).toBe(false);
    expect(byName.set_org_addon?.app_user_ok).toBe(true);
    expect(byName.handle_new_auth_user?.public_ok).toBe(false);
  });
});

describe("the auth trigger without its PUBLIC grant", () => {
  it("still creates the profile row for a new auth user", async () => {
    const id = randomUUID();
    await seedAuthUser(id, `secpriv-trigger-${run}@example.com`);
    const rows = await owner`select id from public.user_profile where id = ${id}`;
    expect(rows.length).toBe(1);
    await owner`delete from public.user_profile where id = ${id}`;
    await owner`delete from auth.users where id = ${id}`;
  });
});

describe("app.rate_limit_hit — the shared fixed-window store", () => {
  const hit = async (key: string, limit: number, windowSeconds: number) => {
    const rows = (await withCtx(ctxOf(orgA, userA), (tx) =>
      tx.execute(
        sql`select allowed, remaining, retry_after from app.rate_limit_hit(${key}, ${limit}, ${windowSeconds})`,
      ),
    )) as unknown as Array<{ allowed: boolean; remaining: number; retry_after: number }>;
    return rows[0]!;
  };

  it("allows up to the limit and refuses the next call with a retry-after", async () => {
    // A wide window: each call is a remote round trip, so the count must not
    // depend on how fast the database answers.
    const key = `test:${run}:${randomUUID()}`;
    const first = await hit(key, 2, 60);
    const second = await hit(key, 2, 60);
    const third = await hit(key, 2, 60);
    expect(first.allowed).toBe(true);
    expect(Number(first.remaining)).toBe(1);
    expect(second.allowed).toBe(true);
    expect(Number(second.remaining)).toBe(0);
    expect(third.allowed).toBe(false);
    expect(Number(third.retry_after)).toBeGreaterThanOrEqual(1);
    expect(Number(third.retry_after)).toBeLessThanOrEqual(60);
  }, 20_000);

  it("rolls the window over once it has elapsed", async () => {
    const key = `test:${run}:${randomUUID()}`;
    const first = await hit(key, 1, 4);
    const second = await hit(key, 1, 4);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 4_500));
    const again = await hit(key, 1, 4);
    expect(again.allowed).toBe(true);
  }, 30_000);

  it("counts one budget across independent connections", async () => {
    const key = `test:${run}:${randomUUID()}`;
    const results = await Promise.all([
      hit(key, 3, 60),
      hit(key, 3, 60),
      hit(key, 3, 60),
      hit(key, 3, 60),
    ]);
    expect(results.filter((r) => r.allowed).length).toBe(3);
    expect(results.filter((r) => !r.allowed).length).toBe(1);
  });

  it("refuses a malformed rule and keeps the counter table private", async () => {
    await expect(hit("", 1, 1)).rejects.toBeTruthy();
    await expect(hit("x", 0, 1)).rejects.toBeTruthy();
    await expect(
      withCtx(ctxOf(orgA, userA), (tx) =>
        tx.execute(sql`select count(*) from app.rate_limit_bucket`),
      ),
    ).rejects.toBeTruthy();
  });
});
