/**
 * S9 support impersonation (integration). Proves the DoD AC — "a support session is visible in the
 * tenant's OWN audit log" — plus the consent-or-break-glass gate, the platform-staff gate, and the
 * end/idempotency semantics.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, sql, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  startImpersonation,
  endImpersonation,
  listImpersonations,
  hasActiveImpersonation,
} from "@/modules/support/service";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const ownerUser = randomUUID();
const staffUser = randomUUID();
const outsiderUser = randomUUID();
let orgId = "";
const ctx = (): Ctx => ({
  orgId,
  userId: ownerUser,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "s9-imp-test",
});

async function auditActions(): Promise<string[]> {
  return withCtx(ctx(), async (tx) => {
    const rows = (await tx.execute(sql`
      select action from public.audit_log
      where org_id = ${orgId} and entity_type = 'impersonation_session' order by created_at`)) as unknown as Array<{
      action: string;
    }>;
    return rows.map((r) => r.action);
  });
}

beforeAll(async () => {
  for (const [id, who] of [
    [ownerUser, "Owner"],
    [staffUser, "Staff"],
    [outsiderUser, "Outsider"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`s9imp-${who}-${run}@example.com`}, ${JSON.stringify({ full_name: who })}::jsonb, now(), now())`;
  }
  orgId = await createOrgForUser(ownerUser, {
    name: "S9 Imp Org",
    country: "AE",
    baseCurrency: "AED",
  });
  // Seed the platform-staff allow-list (a platform bootstrap operation, done as owner).
  await owner`insert into public.platform_staff (user_id, active) values (${staffUser}, true)`;
}, 120_000);

afterAll(async () => {
  await owner`delete from public.platform_staff where user_id = ${staffUser}`;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("support impersonation (consent-gated, dual-logged)", () => {
  it("a consented session is created and appears in the tenant's OWN audit log", async () => {
    const { sessionId } = await startImpersonation({
      orgId,
      staffUserId: staffUser,
      reason: "help with an invoice",
      consentGrantedBy: ownerUser,
    });
    expect(sessionId).toBeTruthy();
    expect(await hasActiveImpersonation(ctx())).toBe(true);
    const list = await listImpersonations(ctx(), "owner", true);
    expect(list.some((s) => s.id === sessionId && s.reason === "help with an invoice")).toBe(true);
    // The DoD AC: the tenant sees the session start in its own audit log.
    expect(await auditActions()).toContain("support.impersonation_started");

    // Ending closes it + dual-logs; a second end is a no-op.
    await endImpersonation(sessionId);
    expect(await hasActiveImpersonation(ctx())).toBe(false);
    await endImpersonation(sessionId); // idempotent
    expect(await auditActions()).toContain("support.impersonation_ended");
  });

  it("refuses without consent AND without break-glass (no session created)", async () => {
    const before = (await owner`select count(*)::int as n from public.impersonation_session
      where org_id = ${orgId}`) as unknown as Array<{ n: number }>;
    // The DB consent-or-break-glass CHECK + guard reject it (postgres.js wraps the raise, so we
    // assert rejection + that no row was written rather than the wrapped message text).
    await expect(
      startImpersonation({ orgId, staffUserId: staffUser, reason: "no consent given" }),
    ).rejects.toThrow();
    const after = (await owner`select count(*)::int as n from public.impersonation_session
      where org_id = ${orgId}`) as unknown as Array<{ n: number }>;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("allows a break-glass session (no consent) and records it as such", async () => {
    const { sessionId } = await startImpersonation({
      orgId,
      staffUserId: staffUser,
      reason: "production incident",
      breakGlass: true,
    });
    const list = await listImpersonations(ctx(), "owner");
    expect(list.some((s) => s.id === sessionId && s.breakGlass)).toBe(true);
    await endImpersonation(sessionId);
  });

  it("refuses a non-staff actor (the platform_staff gate)", async () => {
    await expect(
      startImpersonation({
        orgId,
        staffUserId: outsiderUser,
        reason: "not staff",
        consentGrantedBy: ownerUser,
      }),
    ).rejects.toThrow();
    // The outsider never opened a session.
    const rows = (await owner`select count(*)::int as n from public.impersonation_session
      where org_id = ${orgId} and staff_user_id = ${outsiderUser}`) as unknown as Array<{
      n: number;
    }>;
    expect(rows[0]!.n).toBe(0);
  });
});
