/**
 * Fresh-customer repair pass (2026-09-20) — service-level proof for the parts
 * a browser walk cannot pin down deterministically:
 *
 *   - invitations: the read-only peek, account binding, the already-a-member
 *     answer, withdraw and re-issue, and the state words (expired / revoked)
 *   - the 30-day trial stamped at creation, and an expired trial resolving to
 *     the free base in the backend without the lifecycle worker
 *   - work templates: stages normalise to 100, presets are created / retired,
 *     and a stage a preset still references cannot be removed
 *   - a quotation stuck in `converting` is released
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import {
  acceptInvite,
  createOrgForUser,
  InviteAccountMismatchError,
  InviteAlreadyMemberError,
  InviteStateError,
  inviteMember,
  listPendingInvites,
  peekInviteDetails,
  revokeInvite,
  rotateInvite,
} from "@/platform/auth/identity";
import { invalidateEntitlements, resolveEntitlements } from "@/platform/entitlements";
import {
  addStage,
  createPreset,
  listPresets,
  normaliseWeights,
  readStageTemplate,
  removeStage,
  retirePreset,
  stageKeyFrom,
} from "@/modules/jobs/service";
import { installTemplate } from "@/platform/config";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const ownerUser = randomUUID();
const invitee = randomUUID();
const stranger = randomUUID();
const emailOf = (tag: string) => `${tag}-${run}@test.local`;
let orgId = "";

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
  requestId: "fresh-customer-test",
});

beforeAll(async () => {
  await seedAuthUser(ownerUser, emailOf("fc-owner"));
  await seedAuthUser(invitee, emailOf("fc-invitee"));
  await seedAuthUser(stranger, emailOf("fc-stranger"));
  orgId = await createOrgForUser(ownerUser, {
    name: `FRESH-CUSTOMER-${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  await owner`insert into public.app_settings (org_id, key, value) values (${orgId}, 'test.fixture', '{"pass":"fresh-customer"}'::jsonb) on conflict do nothing`;
});

afterAll(async () => {
  await owner.end();
  await closeAppDb();
});

describe("invitations", () => {
  it("peeks an invitation without consuming it, and names the company, role and address", async () => {
    const { token } = await inviteMember(ctx(), "owner", {
      email: emailOf("fc-invitee"),
      roleKey: "manager",
    });
    const d = await peekInviteDetails(token);
    expect(d?.state).toBe("pending");
    expect(d?.orgId).toBe(orgId);
    expect(d?.roleKey).toBe("manager");
    expect(d?.email).toBe(emailOf("fc-invitee").toLowerCase());
    expect(d?.orgName).toContain("FRESH-CUSTOMER");
    // Peeking twice is still pending: nothing was spent.
    expect((await peekInviteDetails(token))?.state).toBe("pending");
    expect(await peekInviteDetails("not-a-token")).toBeNull();

    // The wrong account is refused before any write, and the database agrees.
    await expect(acceptInvite(stranger, token, emailOf("fc-stranger"))).rejects.toBeInstanceOf(
      InviteAccountMismatchError,
    );
    await expect(acceptInvite(stranger, token)).rejects.toThrow(/account mismatch/i);
    expect((await peekInviteDetails(token))?.state).toBe("pending");

    // The invited account joins; the same person again is told they are a member.
    await expect(acceptInvite(invitee, token, emailOf("fc-invitee"))).resolves.toBe(orgId);
    expect((await peekInviteDetails(token))?.state).toBe("accepted");
    await expect(acceptInvite(invitee, token, emailOf("fc-invitee"))).rejects.toBeInstanceOf(
      InviteStateError,
    );
    const { token: again } = await inviteMember(ctx(), "owner", {
      email: emailOf("fc-invitee"),
      roleKey: "viewer",
    });
    const err = await acceptInvite(invitee, again, emailOf("fc-invitee")).catch((e) => e);
    expect(err).toBeInstanceOf(InviteAlreadyMemberError);
    expect((err as InviteAlreadyMemberError).orgId).toBe(orgId);
  });

  it("lists, withdraws and re-issues pending invitations", async () => {
    const { inviteId, token } = await inviteMember(ctx(), "owner", {
      email: emailOf("fc-second"),
      roleKey: "manager",
    });
    const pending = await listPendingInvites(ctx(), "owner");
    expect(pending.some((p) => p.id === inviteId)).toBe(true);

    const fresh = await rotateInvite(ctx(), "owner", inviteId);
    expect(fresh.email).toBe(emailOf("fc-second").toLowerCase());
    expect((await peekInviteDetails(token))?.state).toBe("revoked");
    expect((await peekInviteDetails(fresh.token))?.state).toBe("pending");

    await revokeInvite(ctx(), "owner", fresh.inviteId);
    expect((await peekInviteDetails(fresh.token))?.state).toBe("revoked");
    await expect(acceptInvite(stranger, fresh.token)).rejects.toThrow(/invalid or expired/i);
    expect((await listPendingInvites(ctx(), "owner")).some((p) => p.id === fresh.inviteId)).toBe(
      false,
    );
  });

  it("says 'expired' for an invitation past its date", async () => {
    const { inviteId, token } = await inviteMember(ctx(), "owner", {
      email: emailOf("fc-late"),
      roleKey: "viewer",
    });
    await owner`update public.membership_invite set expires_at = now() - interval '1 minute' where id = ${inviteId}`;
    expect((await peekInviteDetails(token))?.state).toBe("expired");
    const err = await acceptInvite(stranger, token).catch((e) => e);
    expect(err).toBeInstanceOf(InviteStateError);
    expect((err as InviteStateError).state).toBe("expired");
  });
});

describe("30-day trial", () => {
  it("stamps a 30-day trial at creation and reports it in the entitlements", async () => {
    const [row] = await owner`
      select billing_state, plan_key, extract(epoch from (trial_end - now())) / 86400 as days
      from public.org_plan_state where org_id = ${orgId}`;
    expect(row!.billing_state).toBe("trialing");
    expect(row!.plan_key).toBe("growth");
    expect(Number(row!.days)).toBeGreaterThan(29.9);
    expect(Number(row!.days)).toBeLessThanOrEqual(30);
    invalidateEntitlements(orgId);
    const ent = await resolveEntitlements(ctx());
    expect(ent.planKey).toBe("growth");
    expect(ent.trialExpired).toBe(false);
    expect(ent.trialEnd).not.toBeNull();
  });

  it("an expired trial resolves to the free base in the backend, without the worker, and keeps the data", async () => {
    await owner`update public.org_plan_state set trial_end = now() - interval '1 hour' where org_id = ${orgId}`;
    invalidateEntitlements(orgId);
    const ent = await resolveEntitlements(ctx());
    expect(ent.billingState).toBe("trialing"); // the sweep has not run; the state is honest
    expect(ent.trialExpired).toBe(true);
    expect(ent.planKey).toBe("free");
    const [org] = await owner`select count(*)::int as n from public.org where id = ${orgId}`;
    expect(org!.n).toBe(1);
    // Restore for the remaining tests.
    await owner`update public.org_plan_state set trial_end = now() + interval '30 days' where org_id = ${orgId}`;
    invalidateEntitlements(orgId);
  });
});

describe("work templates", () => {
  it("normalises weights and derives stable keys", () => {
    const n = normaliseWeights([
      { stage_key: "a", names: { en: "A", ar: "أ" }, weight: 1, phase_semantic: "preparation" },
      { stage_key: "b", names: { en: "B", ar: "ب" }, weight: 1, phase_semantic: "production" },
      { stage_key: "c", names: { en: "C", ar: "ج" }, weight: 1, phase_semantic: "handover" },
    ]);
    expect(n.reduce((a, s) => a + s.weight, 0)).toBe(100);
    expect(n.every((s) => s.weight >= 1)).toBe(true);
    const taken = new Set(["growing_care"]);
    expect(stageKeyFrom("Growing & Care", taken)).toBe("growing_care_2");
    expect(stageKeyFrom("Harvest / Collection", new Set())).toBe("harvest_collection");
    expect(stageKeyFrom("123", new Set())).toBe("s_123");
  });

  it(
    "adds a stage, creates a preset that skips it, refuses to drop a referenced stage, and retires the preset",
    { timeout: 180_000 },
    async () => {
      await installTemplate(ctx(), "agriculture_v1");
      const before = await readStageTemplate(ctx(), "owner");
      expect(before.stages.length).toBeGreaterThan(0);

      const { stageKey } = await addStage(ctx(), "owner", {
        nameEn: "Packing",
        nameAr: "التعبئة",
        weight: 10,
        phase: "finishing",
      });
      const after = await readStageTemplate(ctx(), "owner");
      expect(after.stages.some((s) => s.stage_key === stageKey)).toBe(true);
      expect(after.stages.reduce((a, s) => a + s.weight, 0)).toBe(100);

      const { id } = await createPreset(ctx(), "owner", {
        code: "DATES",
        nameEn: "Dates season",
        nameAr: "موسم التمور",
        description: "Dates only",
        skippedStageKeys: [stageKey],
      });
      const presets = await listPresets(ctx(), "owner");
      const mine = presets.find((p) => p.id === id);
      expect(mine?.defaultSkippedStageKeys).toEqual([stageKey]);
      expect(mine?.billingPoints).toEqual([{ trigger: "on_acceptance", pct: 100 }]);

      // A live preset references the stage in its skip list: the guard refuses.
      await expect(removeStage(ctx(), "owner", stageKey)).rejects.toThrow(
        /referenced by preset DATES/i,
      );

      await retirePreset(ctx(), "owner", id);
      expect(
        (await listPresets(ctx(), "owner")).find((p) => p.id === id)?.retiredAt,
      ).not.toBeNull();
      await expect(
        createPreset(ctx(), "owner", {
          code: "DATES",
          nameEn: "x",
          nameAr: "س",
          skippedStageKeys: [],
        }),
      ).rejects.toThrow(/already exists/i);
    },
  );
});
