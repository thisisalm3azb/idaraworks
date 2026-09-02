/**
 * H25L — the private channel law, tested where it is enforced: RLS on
 * realtime.messages. Supabase evaluates the policies at subscribe time as the
 * `authenticated` role with the JWT claims set (the topic is passed to the predicate); we
 * reproduce exactly that inside rolled-back transactions and assert (a) the
 * predicate the policies delegate to and (b) that both policies exist and
 * delegate to it. (An INSERT into realtime.messages cannot be used as the
 * probe: the table is day-partitioned by the Realtime service, and partition
 * routing rejects a test row before RLS is reached.)
 *
 * Properties: a member of the org passes on the plan's topic; a signed-in
 * non-member does not; foreign, malformed and non-studio topics are refused
 * even for a member; the send and receive policies both require broadcast or
 * presence AND the predicate.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const member = randomUUID();
const stranger = randomUUID();
let orgA = "";
const planId = randomUUID(); // the topic only needs a plausible id; membership is what is checked

beforeAll(async () => {
  for (const [id, name] of [
    [member, "Member"],
    [stranger, "Stranger"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h25l-${name.toLowerCase()}-${run}@example.invalid`},
              ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(member, { name: "H25L", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h25l", run);
}, 300_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA]);
  for (const u of [member, stranger]) {
    await owner`delete from public.user_profile where id = ${u}`;
    await owner`delete from auth.users where id = ${u}`;
  }
  await owner.end();
  await closeAppDb();
});

/** Evaluate the policies' predicate exactly as Realtime would: as `authenticated` with claims. */
async function allowed(userId: string, topic: string): Promise<boolean> {
  let ok = false;
  await owner
    .begin(async (tx) => {
      await tx.unsafe(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ]);
      await tx.unsafe(`set local role authenticated`);
      const r = (await tx.unsafe(`select app.studio_channel_allowed($1) as ok`, [topic])) as Array<{
        ok: boolean;
      }>;
      ok = r[0]?.ok === true;
      throw new Error("__rollback__");
    })
    .catch((err: { message?: string }) => {
      if (err.message !== "__rollback__") throw err;
    });
  return ok;
}

describe("private plan channels", () => {
  it("a member passes on the plan's topic", async () => {
    expect(await allowed(member, `studio:${orgA}:${planId}`)).toBe(true);
  });

  it("a signed-in non-member is refused", async () => {
    expect(await allowed(stranger, `studio:${orgA}:${planId}`)).toBe(false);
  });

  it("foreign, malformed and non-studio topics are refused even for a member", async () => {
    expect(await allowed(member, `studio:${randomUUID()}:${planId}`)).toBe(false);
    expect(await allowed(member, `studio:not-an-org:${planId}`)).toBe(false);
    expect(await allowed(member, `chat:${orgA}`)).toBe(false);
    expect(await allowed(member, "")).toBe(false);
  });

  it("both policies exist on realtime.messages and delegate to the predicate", async ({ skip }) => {
    const present =
      (await owner`select to_regclass('realtime.messages') as t`) as unknown as Array<{
        t: string | null;
      }>;
    if (present[0]?.t === null)
      skip("realtime.messages is not provisioned on this stack (CI local)");
    const rows = (await owner`
      select policyname, cmd, roles::text as roles, qual, with_check
      from pg_policies where schemaname = 'realtime' and tablename = 'messages'
        and policyname in ('studio_channel_receive', 'studio_channel_send')
      order by policyname`) as unknown as Array<{
      policyname: string;
      cmd: string;
      roles: string;
      qual: string | null;
      with_check: string | null;
    }>;
    expect(rows.map((r) => r.policyname)).toEqual([
      "studio_channel_receive",
      "studio_channel_send",
    ]);
    const receive = rows[0]!;
    const send = rows[1]!;
    expect(receive.cmd).toBe("SELECT");
    expect(send.cmd).toBe("INSERT");
    for (const r of rows) expect(r.roles).toContain("authenticated");
    for (const expr of [receive.qual, send.with_check]) {
      expect(expr).toContain("app.studio_channel_allowed(realtime.topic())");
      expect(expr).toContain("'broadcast'");
      expect(expr).toContain("'presence'");
      expect(expr).not.toContain("postgres_changes");
    }
    // The predicate is definer-owned and only callable by signed-in users.
    const fn = (await owner`
      select p.prosecdef as definer,
             has_function_privilege('authenticated', p.oid, 'execute') as auth_ok,
             has_function_privilege('anon', p.oid, 'execute') as anon_ok
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = 'studio_channel_allowed'`) as unknown as Array<{
      definer: boolean;
      auth_ok: boolean;
      anon_ok: boolean;
    }>;
    expect(fn[0]).toMatchObject({ definer: true, auth_ok: true, anon_ok: false });
  });
});
