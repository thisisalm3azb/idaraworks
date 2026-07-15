/**
 * Seat recount at ACCEPT (0069, integration, real DB) — the review scenario: a pending
 * invite created while the plan allowed it must NOT be acceptable after a downgrade
 * drops the seat cap below the would-be count. Also: foreman (field) seats accept at
 * the cap (never limited), an addon.members_10 grant unblocks the accept, and the
 * invalid-token error surface is unchanged (peek miss falls through to app.accept_invite).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import {
  acceptInvite,
  createOrgForUser,
  inviteMember,
  SeatLimitError,
} from "@/platform/auth/identity";
import { invalidateEntitlements } from "@/platform/entitlements";
import { ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);

const ownerUser = randomUUID();
const mgr1 = randomUUID();
const mgr2 = randomUUID();
const mgr3 = randomUUID(); // the blocked 4th full seat (invited pre-downgrade)
const foreman1 = randomUUID();
const users = [ownerUser, mgr1, mgr2, mgr3, foreman1];
const emailOf = (name: string) => `${name}-${run}@test.local`;

let orgId = "";
let blockedToken = ""; // manager invite issued BEFORE the downgrade — the review case

async function seedAuthUser(id: string, email: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${email}, ${JSON.stringify({ full_name: email.split("@")[0] })}::jsonb, now(), now())
    on conflict (id) do nothing`;
}

const ctx = (): Ctx => ({
  orgId,
  userId: ownerUser,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "seat-accept-test",
});

beforeAll(async () => {
  await seedAuthUser(ownerUser, emailOf("seat-owner"));
  await seedAuthUser(mgr1, emailOf("seat-mgr1"));
  await seedAuthUser(mgr2, emailOf("seat-mgr2"));
  await seedAuthUser(mgr3, emailOf("seat-mgr3"));
  await seedAuthUser(foreman1, emailOf("seat-foreman"));

  orgId = await createOrgForUser(ownerUser, {
    name: `SEAT-ACCEPT-${run}`,
    country: "AE",
    baseCurrency: "AED",
  });

  // Arrange while the growth trial allows it (limit.full_users = 15): fill what will
  // become the free-plan cap — owner + 2 ACCEPTED managers = 3 full seats…
  for (const [userId, email] of [
    [mgr1, emailOf("seat-mgr1")],
    [mgr2, emailOf("seat-mgr2")],
  ] as const) {
    const { token } = await inviteMember(ctx(), "owner", { email, roleKey: "manager" });
    await acceptInvite(userId, token);
  }
  // …plus a 4th full-seat invite left PENDING…
  blockedToken = (
    await inviteMember(ctx(), "owner", { email: emailOf("seat-mgr3"), roleKey: "manager" })
  ).token;
  // …then downgrade to free (limit.full_users = 3, migration 0065) before it is accepted.
  await owner`
    update public.org_plan_state set plan_key = 'free', billing_state = 'active'
    where org_id = ${orgId}`;
  invalidateEntitlements(orgId);
}, 120_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgId], users);
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("seat recount at accept (0069)", () => {
  it("a pending invite from before a downgrade cannot overshoot the dropped cap", async () => {
    const err = await acceptInvite(mgr3, blockedToken).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err, "accept at a full cap must throw").toBeInstanceOf(SeatLimitError);
    expect((err as SeatLimitError).limitKey).toBe("limit.full_users");
    expect((err as SeatLimitError).limit).toBe(3);

    // No membership was created, and the invite was NOT consumed (tx rolled back).
    const [m] = await owner`
      select count(*)::int as n from public.membership
      where org_id = ${orgId} and user_id = ${mgr3}`;
    expect(m!.n).toBe(0);
    const [inv] = await owner`
      select accepted_at from public.membership_invite
      where org_id = ${orgId} and email = ${emailOf("seat-mgr3").toLowerCase()}`;
    expect(inv!.accepted_at).toBeNull();
  });

  it("a foreman invite accepts fine at the cap (field seats are never limited)", async () => {
    const { token } = await inviteMember(ctx(), "owner", {
      email: emailOf("seat-foreman"),
      roleKey: "foreman",
    });
    await expect(acceptInvite(foreman1, token)).resolves.toBe(orgId);
    const [m] = await owner`
      select role_key from public.membership where org_id = ${orgId} and user_id = ${foreman1}`;
    expect(m!.role_key).toBe("foreman");
  });

  it("granting addon.members_10 lets the blocked accept succeed", async () => {
    await owner`
      select app.set_org_addon(${orgId}::uuid, 'addon.members_10', 1, 'active', null, 'individual')`;
    invalidateEntitlements(orgId);

    await expect(acceptInvite(mgr3, blockedToken)).resolves.toBe(orgId);
    const [m] = await owner`
      select role_key from public.membership where org_id = ${orgId} and user_id = ${mgr3}`;
    expect(m!.role_key).toBe("manager");
  });

  it("an invalid token still errors with the canonical message (peek falls through)", async () => {
    await expect(acceptInvite(mgr3, "bogus-token")).rejects.toThrow(/invalid or expired/i);
  });
});
