/**
 * Audit command-path integration (Phase D): mutations write audit_log rows,
 * append-only enforcement, actor binding, and cross-tenant isolation.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, type Ctx } from "@/platform/tenancy";
import { command } from "@/platform/audit";
import {
  acceptInvite,
  createOrgForUser,
  deactivateMember,
  inviteMember,
  listMembers,
} from "@/platform/auth/identity";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const userA = randomUUID(); // org A owner
const userB = randomUUID(); // org B owner (isolation)
const userC = randomUUID(); // invitee into A (deactivated)
const userD = randomUUID(); // active manager in A (read-gate)
let orgA = "";
let orgB = "";

async function seedAuthUser(id: string, email: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${email}, ${JSON.stringify({ full_name: email.split("@")[0] })}::jsonb, now(), now())
    on conflict (id) do nothing`;
}

const emailC = `audit-c-${userC.slice(0, 8)}@example.com`;
const emailD = `audit-d-${userD.slice(0, 8)}@example.com`;

beforeAll(async () => {
  await seedAuthUser(userA, `audit-a-${userA.slice(0, 8)}@example.com`);
  await seedAuthUser(userB, `audit-b-${userB.slice(0, 8)}@example.com`);
  await seedAuthUser(userC, emailC);
  await seedAuthUser(userD, emailD);
  orgA = await createOrgForUser(userA, { name: "Audit A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "Audit B", country: "SA", baseCurrency: "SAR" });
}, 60_000);

afterAll(async () => {
  for (const org of [orgA, orgB].filter(Boolean)) {
    await owner`delete from public.audit_log where org_id = ${org}`;
    await owner`delete from public.org_plan_state where org_id = ${org}`;
    await owner`delete from public.membership_invite where org_id = ${org}`;
    await owner`delete from public.membership where org_id = ${org}`;
    await owner`delete from public.role_definition where org_id = ${org}`;
    await owner`delete from public.company where org_id = ${org}`;
    await owner`delete from public.org where id = ${org}`;
  }
  await owner`delete from public.user_profile where id in (${userA}, ${userB}, ${userC}, ${userD})`;
  await owner`delete from auth.users where id in (${userA}, ${userB}, ${userC}, ${userD})`;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  requestId: "t",
});

describe("mutations write audit_log via the command path", () => {
  it("org.create left an audit row", async () => {
    const [row] = await owner`
      select action, actor_user_id::text, entity_type, summary
      from public.audit_log where org_id = ${orgA} and action = 'org.create'`;
    expect(row).toBeDefined();
    expect(row!.actor_user_id).toBe(userA);
    expect(row!.entity_type).toBe("org");
  });

  it("invite + accept + deactivate each write their audit rows", async () => {
    const { token } = await inviteMember(ctxOf(orgA, userA), "owner", {
      email: emailC,
      roleKey: "manager",
    });
    await acceptInvite(userC, token);
    const members = await listMembers(ctxOf(orgA, userA), "owner");
    const cMember = members.find((m) => m.userId === userC)!;
    await deactivateMember(ctxOf(orgA, userA), "owner", cMember.membershipId);

    const actions = (
      await owner`select action from public.audit_log where org_id = ${orgA} order by created_at`
    ).map((r) => r.action);
    expect(actions).toContain("membership_invite.create");
    expect(actions).toContain("membership.join");
    expect(actions).toContain("membership.deactivate");

    const [deact] = await owner`
      select entity_id::text, before_data, after_data from public.audit_log
      where org_id = ${orgA} and action = 'membership.deactivate'`;
    expect(deact!.entity_id).toBe(cMember.membershipId);
    expect(deact!.before_data).toEqual({ active: true });
    expect(deact!.after_data).toEqual({ active: false });
  });

  it("audit is atomic with the mutation — a failing mutation writes no audit", async () => {
    const before = (
      await owner`select count(*)::int as n from public.audit_log where org_id = ${orgA}`
    )[0]!.n;
    await expect(
      command(
        ctxOf(orgA, userA),
        { audit: { action: "test.fail", entityType: "org", summary: "should roll back" } },
        async () => {
          throw new Error("mutation failed");
        },
      ),
    ).rejects.toThrow(/mutation failed/);
    const after = (
      await owner`select count(*)::int as n from public.audit_log where org_id = ${orgA}`
    )[0]!.n;
    expect(after).toBe(before); // rolled back, no audit row
  });
});

// A query error inside a transaction aborts it, so the error escapes at the
// withCtx boundary (as a raw PostgresError) rather than being catchable inside.
// Catch outside and read the SQLSTATE from either the error or its drizzle cause.
async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!err) return undefined;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}

describe("append-only enforcement (doc 10 #34)", () => {
  it("app_user cannot UPDATE or DELETE audit_log", async () => {
    const upd = await pgCode(
      withCtx(ctxOf(orgA, userA), (tx) =>
        tx.execute(sql`update public.audit_log set summary = 'tamper' where org_id = ${orgA}`),
      ),
    );
    expect(upd).toBe("42501"); // insufficient_privilege (no UPDATE grant)
    const del = await pgCode(
      withCtx(ctxOf(orgA, userA), (tx) =>
        tx.execute(sql`delete from public.audit_log where org_id = ${orgA}`),
      ),
    );
    expect(del).toBe("42501");
  });
});

describe("audit reads are role-gated (compliance stream, 0007)", () => {
  it("an active non-privileged member cannot read audit_log; the owner can", async () => {
    // Make userD an ACTIVE manager in org A (archetype not in owner/admin/accounts).
    const { token } = await inviteMember(ctxOf(orgA, userA), "owner", {
      email: emailD,
      roleKey: "manager",
    });
    await acceptInvite(userD, token);

    const ownerSeen = (await withCtx(
      ctxOf(orgA, userA),
      (tx) => tx.execute(sql`select count(*)::int as n from public.audit_log`),
    )) as unknown as Array<{ n: number }>;
    expect(ownerSeen[0]!.n).toBeGreaterThan(0); // owner reads the compliance log

    const managerSeen = (await withCtx(
      ctxOf(orgA, userD),
      (tx) => tx.execute(sql`select count(*)::int as n from public.audit_log`),
    )) as unknown as Array<{ n: number }>;
    expect(managerSeen[0]!.n).toBe(0); // RLS select gates to privileged archetypes
  });
});

describe("cross-tenant isolation", () => {
  it("org B cannot see org A's audit rows", async () => {
    const seen = await withCtx(ctxOf(orgB, userB), async (tx) => {
      return (await tx.execute(
        sql`select distinct org_id::text as org_id from public.audit_log`,
      )) as unknown as Array<{ org_id: string }>;
    });
    for (const r of seen) expect(r.org_id).toBe(orgB);
  });

  it("the audit actor cannot be forged (with_check binds actor = caller)", async () => {
    const code = await pgCode(
      withCtx(ctxOf(orgA, userA), (tx) =>
        tx.execute(
          sql`insert into public.audit_log (org_id, actor_user_id, action, entity_type, summary)
              values (${orgA}, ${userB}, 'forged', 'org', 'not me')`,
        ),
      ),
    );
    expect(code).toBe("42501"); // RLS with_check rejects actor != current_user
  });
});
