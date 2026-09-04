/**
 * H32 guided onboarding (integration, real DB).
 *
 * The unit tests pin the content and the eligibility rule. These pin the two
 * things only a database can prove, and both are promises the mandate makes in
 * so many words:
 *
 *   • "No tenant can read another tenant's onboarding progress."
 *   • "Administrators cannot mark another user's tour complete."
 *
 * The second is the interesting one. It is not enforced by a permission check
 * in the service — it is enforced by the row-level-security policy naming the
 * current USER as well as the current org, so there is no call site that could
 * forget it and no request shape that could ask for it. A test that only drove
 * the service would not distinguish those two worlds, so these drive the raw
 * tenant connection as an administrator and watch it fail to see or touch a
 * colleague's row.
 *
 * Self-cleaning (wipeOrgs).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, sql, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  dismissChecklist,
  loadOnboarding,
  restartTour,
  saveProgress,
} from "@/modules/guidedtour/service";
import { markFixtureOrg, ownerSql, requireIntegrationEnv, wipeOrgs } from "./helpers";

requireIntegrationEnv();

const owner = ownerSql();
const run = randomUUID().slice(0, 8);

/** Org A: an owner and an administrator, so "colleague" is a real relationship. */
const userOwnerA = randomUUID();
const userAdminA = randomUUID();
/** A third member of Org A, used only to prove nobody can write a row for them. */
const userThirdA = randomUUID();
/** Org B: a different company entirely. */
const userOwnerB = randomUUID();

let orgA = "";
let orgB = "";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h32",
});

async function seedAuthUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h32-${label}-${run}@example.com`}, '{"full_name":"H32"}'::jsonb, now(), now())`;
}

/** Read a progress row through the OWNER connection: the ground truth. */
async function rawRow(orgId: string, userId: string) {
  const rows = (await owner`
    select status, step_index, tour_key, completed_at, checklist_dismissed_at
    from public.onboarding_state
    where org_id = ${orgId} and user_id = ${userId}`) as unknown as Array<{
    status: string;
    step_index: number;
    tour_key: string | null;
    completed_at: Date | null;
    checklist_dismissed_at: Date | null;
  }>;
  return rows[0] ?? null;
}

beforeAll(async () => {
  for (const [id, label] of [
    [userOwnerA, "owner-a"],
    [userAdminA, "admin-a"],
    [userThirdA, "third-a"],
    [userOwnerB, "owner-b"],
  ] as const) {
    await seedAuthUser(id, label);
  }

  orgA = await createOrgForUser(userOwnerA, { name: "H32 A", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h32-guided-onboarding", run);
  await owner`
    insert into public.membership (user_id, org_id, role_key)
    values (${userAdminA}, ${orgA}, 'admin'),
           (${userThirdA}, ${orgA}, 'viewer')`;

  orgB = await createOrgForUser(userOwnerB, { name: "H32 B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgB, "h32-guided-onboarding", run);
}, 120_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userOwnerA, userAdminA, userThirdA, userOwnerB]);
  await owner.end();
  await closeAppDb();
});

describe("progress round-trips", () => {
  it("saves and reads back the person's own state", async () => {
    const ctx = ctxOf(orgA, userOwnerA);
    await saveProgress(ctx, { status: "in_progress", stepIndex: 2, tourKey: "owner" });

    const loaded = await loadOnboarding(ctx, "owner");
    expect(loaded.state.status).toBe("in_progress");
    expect(loaded.state.stepIndex).toBe(2);
    expect(loaded.state.tourKey).toBe("owner");
  });

  it("never moves the step backwards while the tour is running", async () => {
    // Two tabs, one a step behind. The stale one must not undo real progress.
    const ctx = ctxOf(orgA, userOwnerA);
    await saveProgress(ctx, { status: "in_progress", stepIndex: 4, tourKey: "owner" });
    await saveProgress(ctx, { status: "in_progress", stepIndex: 1, tourKey: "owner" });
    expect((await loadOnboarding(ctx, "owner")).state.stepIndex).toBe(4);
  });

  it("records completion with a timestamp, and restarting clears it", async () => {
    const ctx = ctxOf(orgA, userOwnerA);
    await saveProgress(ctx, { status: "completed", stepIndex: 7, tourKey: "owner" });
    expect((await rawRow(orgA, userOwnerA))?.completed_at).toBeInstanceOf(Date);

    await restartTour(ctx, "owner");
    const after = await rawRow(orgA, userOwnerA);
    expect(after?.status).toBe("in_progress");
    // A restart legitimately resets the position; the never-backwards rule is
    // for concurrent tabs, not for somebody asking to start again.
    expect(after?.step_index).toBe(0);
    expect(after?.completed_at).toBeNull();
  });

  it("dismissing the checklist is independent of the tour", async () => {
    const ctx = ctxOf(orgA, userOwnerA);
    await dismissChecklist(ctx);
    const loaded = await loadOnboarding(ctx, "owner");
    expect(loaded.state.checklistDismissed).toBe(true);
    // Still in_progress from the restart above: dismissing one did not end the
    // other.
    expect(loaded.state.status).toBe("in_progress");
  });
});

describe("one person's progress is their own", () => {
  it("an administrator does not see a colleague's progress", async () => {
    // The owner of Org A has a row by now (the tests above wrote one).
    expect(await rawRow(orgA, userOwnerA)).not.toBeNull();

    const adminView = await loadOnboarding(ctxOf(orgA, userAdminA), "admin");
    // Their own blank state, not the owner's step 0 / in_progress.
    expect(adminView.state.status).toBe("new");
    expect(adminView.state.tourKey).toBeNull();
    expect(adminView.state.checklistDismissed).toBe(false);
  });

  it("an administrator cannot SELECT a colleague's row at all", async () => {
    const rows = await withCtx(ctxOf(orgA, userAdminA), async (tx) =>
      tx.execute(sql`
        select user_id::text as user_id from public.onboarding_state
        where org_id = ${orgA}
      `),
    );
    const visible = (rows as unknown as Array<{ user_id: string }>).map((r) => r.user_id);
    expect(visible).not.toContain(userOwnerA);
  });

  it("an administrator cannot mark a colleague's tour complete", async () => {
    /*
     * The mandate names this explicitly. There is no service call that would
     * attempt it, so the test goes underneath the service and issues the update
     * an attacker (or a future bug) would: through the tenant connection, as a
     * legitimate administrator of the right organisation, naming a colleague.
     */
    await withCtx(ctxOf(orgA, userAdminA), async (tx) => {
      await tx.execute(sql`
        update public.onboarding_state
        set status = 'completed'
        where org_id = ${orgA} and user_id = ${userOwnerA}
      `);
    });
    // RLS made the row invisible to the UPDATE, so it matched nothing.
    expect((await rawRow(orgA, userOwnerA))?.status).toBe("in_progress");
  });

  it("an administrator cannot insert a row on a colleague's behalf", async () => {
    // A real, deactivated-free colleague in the same organisation, so the only
    // thing standing between the administrator and the row is the user half of
    // the policy.
    await expect(
      withCtx(ctxOf(orgA, userAdminA), async (tx) => {
        await tx.execute(sql`
          insert into public.onboarding_state (org_id, user_id, status)
          values (${orgA}, ${userThirdA}, 'completed')
        `);
      }),
    ).rejects.toThrow();

    expect(await rawRow(orgA, userThirdA)).toBeNull();
  });
});

describe("one tenant's progress is invisible to another", () => {
  it("Org B sees nothing of Org A, and Org A's row really exists", async () => {
    // Non-vacuous: the owner connection confirms there IS something to hide.
    expect(await rawRow(orgA, userOwnerA)).not.toBeNull();

    const rows = await withCtx(ctxOf(orgB, userOwnerB), async (tx) =>
      tx.execute(sql`select count(*)::int as n from public.onboarding_state`),
    );
    expect((rows as unknown as Array<{ n: number }>)[0]?.n).toBe(0);
  });

  it("finishing one company's tour does not finish another's", async () => {
    const ctxB = ctxOf(orgB, userOwnerB);
    await saveProgress(ctxB, { status: "completed", stepIndex: 7, tourKey: "owner" });

    expect((await rawRow(orgB, userOwnerB))?.status).toBe("completed");
    // Org A's owner is still mid-tour, untouched.
    expect((await rawRow(orgA, userOwnerA))?.status).toBe("in_progress");
  });

  it("a forged org id writes nothing", async () => {
    const forged = randomUUID();
    await expect(
      withCtx(ctxOf(forged, userOwnerA), async (tx) => {
        await tx.execute(sql`
          insert into public.onboarding_state (org_id, user_id, status)
          values (${forged}, ${userOwnerA}, 'completed')
        `);
      }),
    ).rejects.toThrow();
  });
});

describe("the checklist counts real records and creates none", () => {
  it("starts with nothing done, and adding a customer ticks exactly one box", async () => {
    const ctx = ctxOf(orgB, userOwnerB);

    const before = await loadOnboarding(ctx, "owner");
    expect(before.checklist.map((i) => i.key)).toEqual(["customer", "job", "invoice"]);
    expect(before.checklist.every((i) => !i.done)).toBe(true);

    await owner`
      insert into public.customer (org_id, name)
      values (${orgB}, 'H32 Fixture Customer')`;

    const after = await loadOnboarding(ctx, "owner");
    expect(after.checklist.find((i) => i.key === "customer")?.done).toBe(true);
    expect(after.checklist.find((i) => i.key === "job")?.done).toBe(false);
    expect(after.checklist.find((i) => i.key === "invoice")?.done).toBe(false);
  });

  it("loading onboarding creates no business records", async () => {
    /*
     * The mandate's non-destructive rule, asserted rather than asserted-in-prose.
     * A checklist that seeds an example customer to tick its own box would pass
     * every other test in this file.
     */
    const counts = async () => {
      const [r] = (await owner`
        select
          (select count(*) from public.customer where org_id = ${orgA})::int as customers,
          (select count(*) from public.job where org_id = ${orgA})::int as jobs,
          (select count(*) from public.invoice where org_id = ${orgA})::int as invoices
      `) as unknown as Array<{ customers: number; jobs: number; invoices: number }>;
      return r!;
    };

    const before = await counts();
    const ctx = ctxOf(orgA, userOwnerA);
    await loadOnboarding(ctx, "owner");
    await loadOnboarding(ctx, "owner");
    await saveProgress(ctx, { status: "in_progress", stepIndex: 3, tourKey: "owner" });
    expect(await counts()).toEqual(before);
  });

  it("shows a person only the items they may open", async () => {
    // A viewer can see customers and jobs but not raise anything, so every item
    // they get is unlinked — present, informative, and not a dead end.
    const viewer = await loadOnboarding(ctxOf(orgA, userAdminA), "viewer");
    for (const item of viewer.checklist) expect(item.href).toBeNull();
  });
});

describe("onboarding stays out of the business audit trail", () => {
  it("writes no audit_log rows", async () => {
    /*
     * A deliberate design decision, pinned so a later refactor towards the
     * house `command()` wrapper is a conscious choice rather than an accident.
     * The audit log is the record of who changed the BUSINESS; a few hundred
     * "advanced to step 3" rows per new employee would bury what it is for.
     */
    const count = async () => {
      const [r] = (await owner`
        select count(*)::int as n from public.audit_log where org_id = ${orgA}`) as unknown as Array<{
        n: number;
      }>;
      return r!.n;
    };
    const before = await count();
    const ctx = ctxOf(orgA, userOwnerA);
    await saveProgress(ctx, { status: "in_progress", stepIndex: 5, tourKey: "owner" });
    await dismissChecklist(ctx);
    await restartTour(ctx, "owner");
    expect(await count()).toBe(before);
  });
});
