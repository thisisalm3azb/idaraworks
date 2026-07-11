/**
 * Identity integration tests (Phase C): org-creation bootstrap, role/membership
 * shape, invite own-token flow, deactivation guards, and — the load-bearing one —
 * cross-tenant isolation of every identity table through withCtx.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, withUserCtx, type Ctx } from "@/platform/tenancy";
import {
  acceptInvite,
  createOrgForUser,
  deactivateMember,
  hashInviteToken,
  inviteMember,
  listMembers,
} from "@/platform/auth/identity";
import { listMyOrgs } from "@/platform/auth/resolve";
import { ownerSql } from "./helpers";

const owner = ownerSql();

// Two synthetic auth users (we insert into auth.users directly; the trigger
// creates user_profile rows).
const userA = randomUUID(); // owner of org A
const userB = randomUUID(); // owner of org B
const userC = randomUUID(); // invitee
// Run-unique emails (derived from the random ids) so a partial-cleanup from one
// run can never collide with the next via the auth.users email unique index.
const emailA = `owner-a-${userA.slice(0, 8)}@test.local`;
const emailB = `owner-b-${userB.slice(0, 8)}@test.local`;
const emailC = `invitee-c-${userC.slice(0, 8)}@test.local`;
let orgA = "";
let orgB = "";

async function seedAuthUser(id: string, email: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${email}, ${JSON.stringify({ full_name: email.split("@")[0] })}::jsonb, now(), now())
    on conflict (id) do nothing`;
}

beforeAll(async () => {
  await seedAuthUser(userA, emailA);
  await seedAuthUser(userB, emailB);
  await seedAuthUser(userC, emailC);

  orgA = await createOrgForUser(userA, {
    name: "Alpha Marine",
    country: "AE",
    baseCurrency: "AED",
  });
  orgB = await createOrgForUser(userB, {
    name: "Beta Fabrication",
    country: "SA",
    baseCurrency: "SAR",
  });
}, 60_000);

afterAll(async () => {
  for (const org of [orgA, orgB].filter(Boolean)) {
    await owner`delete from public.audit_log where org_id = ${org}`;
    await owner`delete from public.org_plan_state where org_id = ${org}`;
    await owner`delete from public.sign_in_log where org_id = ${org}`;
    await owner`delete from public.membership_invite where org_id = ${org}`;
    await owner`delete from public.membership where org_id = ${org}`;
    await owner`delete from public.role_definition where org_id = ${org}`;
    await owner`delete from public.company where org_id = ${org}`;
    await owner`delete from public.org where id = ${org}`;
  }
  await owner`delete from public.user_profile where id in (${userA}, ${userB}, ${userC})`;
  await owner`delete from auth.users where id in (${userA}, ${userB}, ${userC})`;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  requestId: "test",
});

describe("org creation bootstrap", () => {
  it("creates org, default company, 7 role presets, and an owner membership", async () => {
    const [company] =
      await owner`select count(*)::int as n from public.company where org_id = ${orgA}`;
    expect(company!.n).toBe(1);
    const [roles] =
      await owner`select count(*)::int as n from public.role_definition where org_id = ${orgA}`;
    expect(roles!.n).toBe(7);
    const [m] =
      await owner`select role_key from public.membership where org_id = ${orgA} and user_id = ${userA}`;
    expect(m!.role_key).toBe("owner");
  });

  it("applies country-aware working weeks (UAE Mon–Fri, KSA Sun–Thu)", async () => {
    const [a] = await owner`select working_week from public.org where id = ${orgA}`;
    const [b] = await owner`select working_week from public.org where id = ${orgB}`;
    expect((a!.working_week as { days: string[] }).days).toContain("fri");
    expect((a!.working_week as { days: string[] }).days).not.toContain("sun");
    expect((b!.working_week as { days: string[] }).days).toContain("sun");
    expect((b!.working_week as { days: string[] }).days).not.toContain("fri");
  });

  it("role presets carry correct cost-visibility flags (doc 06)", async () => {
    const rows = await owner`
      select key, cost_privileged from public.role_definition where org_id = ${orgA} order by key`;
    const map = Object.fromEntries(rows.map((r) => [r.key, r.cost_privileged]));
    expect(map.owner).toBe(true);
    expect(map.accounts).toBe(true);
    expect(map.manager).toBe(false); // manager withheld cost visibility by default
    expect(map.foreman).toBe(false);
  });
});

describe("bootstrap reads (withUserCtx)", () => {
  it("listMyOrgs returns only the user's own orgs", async () => {
    const a = await listMyOrgs(userA);
    expect(a.map((o) => o.orgId)).toEqual([orgA]);
    const c = await listMyOrgs(userC);
    expect(c).toEqual([]);
  });
});

describe("invite own-token flow (no service-role)", () => {
  it("invites, accepts, and creates a membership with the invited role", async () => {
    const { token } = await inviteMember(ctxOf(orgA, userA), "owner", {
      email: emailC,
      roleKey: "manager",
    });
    // raw token never stored — only its hash
    const [stored] = await owner`
      select token_hash from public.membership_invite where org_id = ${orgA} and email = ${emailC.toLowerCase()}`;
    expect(stored!.token_hash).toBe(hashInviteToken(token));
    expect(stored!.token_hash).not.toContain(token);

    const acceptedOrg = await acceptInvite(userC, token);
    expect(acceptedOrg).toBe(orgA);
    const [m] =
      await owner`select role_key, invite_channel from public.membership where org_id = ${orgA} and user_id = ${userC}`;
    expect(m!.role_key).toBe("manager");
    expect(m!.invite_channel).toBe("email");
  });

  it("rejects an expired/invalid token", async () => {
    await expect(acceptInvite(userC, "bogus-token")).rejects.toThrow(/invalid or expired/i);
  });

  it("cannot invite to the owner role", async () => {
    await expect(
      inviteMember(ctxOf(orgA, userA), "owner", { email: "x@test.local", roleKey: "owner" }),
    ).rejects.toThrow(/unknown role/i);
  });

  it("a non-privileged role cannot invite (assertCan)", async () => {
    await expect(
      inviteMember(ctxOf(orgA, userC), "manager", { email: "y@test.local", roleKey: "viewer" }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("member management", () => {
  it("lists members within the org only", async () => {
    const members = await listMembers(ctxOf(orgA, userA), "owner");
    const ids = members.map((m) => m.userId).sort();
    expect(ids).toContain(userA);
    expect(ids).toContain(userC);
    expect(ids).not.toContain(userB); // org B owner never appears in org A
  });

  it("deactivates a member; owner and self are protected", async () => {
    const members = await listMembers(ctxOf(orgA, userA), "owner");
    const cMember = members.find((m) => m.userId === userC)!;
    await deactivateMember(ctxOf(orgA, userA), "owner", cMember.membershipId);
    const [row] =
      await owner`select deactivated_at from public.membership where id = ${cMember.membershipId}`;
    expect(row!.deactivated_at).not.toBeNull();

    const ownerMember = members.find((m) => m.roleKey === "owner")!;
    await expect(
      deactivateMember(ctxOf(orgA, userA), "owner", ownerMember.membershipId),
    ).rejects.toThrow(/owner cannot be deactivated/);
  });

  it("a deactivated member no longer resolves the org (listMyOrgs excludes it)", async () => {
    const orgs = await listMyOrgs(userC);
    expect(orgs).toEqual([]);
  });

  it("a deactivated member STILL appears in the roster (0004 fix; D-1.7 — not a delete)", async () => {
    const members = await listMembers(ctxOf(orgA, userA), "owner");
    const c = members.find((m) => m.userId === userC);
    expect(c, "deactivated member vanished from the roster").toBeDefined();
    expect(c!.deactivatedAt).not.toBeNull(); // visible AND correctly flagged
  });
});

// DB errors surface through drizzle as DrizzleQueryError with the Postgres
// detail on .cause (SQLSTATE code + message). Raw tx.execute in tests sees them.
async function dbCause(p: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected a database error, got none").toBeInstanceOf(Error);
  return (err as { cause?: { code?: string; message?: string } }).cause ?? {};
}

describe("privilege-escalation backstops (0004 hardening)", () => {
  it("app_user cannot UPDATE role_key on a membership even in-org (column grant)", async () => {
    // The RLS with_check only validates org_id; the DB backstop against role
    // escalation is the column-level grant — Postgres rejects with 42501.
    const cause = await dbCause(
      withCtx(ctxOf(orgA, userA), async (tx) => {
        await tx.execute(
          sql`update public.membership set role_key = 'owner' where user_id = ${userC} and org_id = ${orgA}`,
        );
      }),
    );
    expect(cause.code).toBe("42501"); // insufficient_privilege (column-level)
  });

  it("create_org_with_owner rejects a user_id that is not the session user (impersonation)", async () => {
    // withUserCtx sets app.user_id = userA, but we ask the definer fn to create
    // an org owned by userB → the GUC guard must RAISE (P0001).
    const cause = await dbCause(
      withUserCtx(userA, async (tx) => {
        await tx.execute(sql`
          select app.create_org_with_owner(${userB}, 'Impersonated', 'AE', 'AED',
            'Asia/Dubai', string_to_array('en', ','), false)`);
      }),
    );
    expect(cause.code).toBe("P0001");
    expect(cause.message).toMatch(/user mismatch/i);
  });
});

describe("cross-tenant isolation of identity tables", () => {
  it("org A ctx cannot see org B's memberships, roles, or invites", async () => {
    const seen = await withCtx(ctxOf(orgA, userA), async (tx) => {
      const members = (await tx.execute(
        sql`select count(*)::int as n from public.membership`,
      )) as unknown as Array<{ n: number }>;
      const roles = (await tx.execute(
        sql`select count(*)::int as n from public.role_definition`,
      )) as unknown as Array<{ n: number }>;
      const orgs = (await tx.execute(
        sql`select count(*)::int as n from public.org`,
      )) as unknown as Array<{ n: number }>;
      return { members: members[0]!.n, roles: roles[0]!.n, orgs: orgs[0]!.n };
    });
    // org A: userA + userC(deactivated) memberships = 2; 7 roles; org visibility
    // includes own-membership orgs = just A here (A owner belongs only to A).
    expect(seen.roles).toBe(7); // exactly org A's presets, never 14
    expect(seen.orgs).toBe(1); // own org only
    expect(seen.members).toBe(2); // org A members only
  });

  it("a user profile is visible cross-org only to co-members", async () => {
    // userB (org B owner) is NOT a member of org A → invisible in org A ctx.
    const visible = await withCtx(ctxOf(orgA, userA), async (tx) => {
      const rows = (await tx.execute(
        sql`select id::text as id from public.user_profile where id = ${userB}`,
      )) as unknown as Array<{ id: string }>;
      return rows.length;
    });
    expect(visible).toBe(0);
  });

  it("sign_in_log is org-scoped", async () => {
    // sign_in_log now carries auth-session events only (membership events moved to
    // audit_log in Phase D). Whatever rows exist here must be org-A-scoped.
    const rows = await withCtx(ctxOf(orgA, userA), async (tx) => {
      return (await tx.execute(
        sql`select distinct org_id::text as org_id from public.sign_in_log where org_id is not null`,
      )) as unknown as Array<{ org_id: string }>;
    });
    for (const r of rows) expect(r.org_id).toBe(orgA);
  });
});
