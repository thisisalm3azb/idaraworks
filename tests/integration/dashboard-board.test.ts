/**
 * The dashboard board, against the real database.
 *
 * Two promises only a database can prove:
 *   • a person's layout is their own: an administrator of the same company
 *     cannot read, write or insert a colleague's row, and another company sees
 *     nothing at all;
 *   • the loader honours the row: save → read back, reset → default, and a key
 *     that no longer exists is dropped rather than failing the page.
 *
 * Self-cleaning (wipeOrgs).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, sql, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  loadDashboardPref,
  loadPriorities,
  resetDashboardPref,
  saveDashboardPref,
} from "@/modules/dashboard/board-store";
import { availableWidgets, resolveLayout } from "@/modules/dashboard/board";
import { markFixtureOrg, ownerSql, requireIntegrationEnv, wipeOrgs } from "./helpers";

requireIntegrationEnv();

const owner = ownerSql();
const run = randomUUID().slice(0, 8);

const userOwnerA = randomUUID();
const userAdminA = randomUUID();
const userOwnerB = randomUUID();
let orgA = "";
let orgB = "";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "board",
});

async function seedAuthUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`board-${label}-${run}@example.com`}, '{"full_name":"Board"}'::jsonb, now(), now())`;
}

async function rawRow(orgId: string, userId: string) {
  const rows = (await owner`
    select layout from public.user_dashboard_pref
    where org_id = ${orgId} and user_id = ${userId}`) as unknown as Array<{ layout: unknown }>;
  return rows[0] ?? null;
}

beforeAll(async () => {
  for (const [id, label] of [
    [userOwnerA, "owner-a"],
    [userAdminA, "admin-a"],
    [userOwnerB, "owner-b"],
  ] as const) {
    await seedAuthUser(id, label);
  }
  orgA = await createOrgForUser(userOwnerA, {
    name: "Board A",
    country: "AE",
    baseCurrency: "AED",
  });
  await markFixtureOrg(owner, orgA, "dashboard-board", run);
  await owner`insert into public.membership (user_id, org_id, role_key) values (${userAdminA}, ${orgA}, 'admin')`;
  orgB = await createOrgForUser(userOwnerB, {
    name: "Board B",
    country: "AE",
    baseCurrency: "AED",
  });
  await markFixtureOrg(owner, orgB, "dashboard-board", run);
}, 120_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userOwnerA, userAdminA, userOwnerB]);
  await owner.end();
  await closeAppDb();
});

describe("the layout round-trips and resets", () => {
  it("nothing saved means the role default", async () => {
    const ctx = ctxOf(orgA, userOwnerA);
    expect(await loadDashboardPref(ctx)).toBeNull();
    const available = availableWidgets({
      archetype: "owner",
      features: { "cap.jobs": true, "cap.approvals": true },
      disabledModules: new Set(),
      seesPrice: true,
      flags: { stock: false, hr: false },
      adaptive: true,
    });
    const r = resolveLayout(null, "owner", await loadPriorities(ctx), available);
    expect(r.source).toBe("default");
    expect(r.entries[0]?.key).toBe("attention");
  });

  it("saves, reads back, and a retired key is dropped on read", async () => {
    const ctx = ctxOf(orgA, userOwnerA);
    await saveDashboardPref(ctx, {
      v: 1,
      widgets: [
        { key: "approvals", size: "m", hidden: false },
        { key: "attention", size: "l", hidden: true },
      ],
    });
    const back = await loadDashboardPref(ctx);
    expect(back?.widgets.map((w) => w.key)).toEqual(["approvals", "attention"]);

    // A key written by an older release of the product.
    await owner`
      update public.user_dashboard_pref
      set layout = '{"v":1,"widgets":[{"key":"retired_widget","size":"m"},{"key":"approvals","size":"s"}]}'::jsonb
      where org_id = ${orgA} and user_id = ${userOwnerA}`;
    const available = availableWidgets({
      archetype: "owner",
      features: { "cap.jobs": true, "cap.approvals": true },
      disabledModules: new Set(),
      seesPrice: true,
      flags: { stock: false, hr: false },
      adaptive: true,
    });
    const r = resolveLayout(await loadDashboardPref(ctx), "owner", [], available);
    expect(r.entries.map((e) => e.key)).toEqual(["approvals"]);
    expect(r.dropped).toEqual(["retired_widget"]);
  });

  it("a malformed stored value reads as null rather than failing", async () => {
    const ctx = ctxOf(orgA, userOwnerA);
    // The CHECK refuses non-object shapes; a well-shaped but wrong version is
    // the case the application must survive.
    await owner`
      update public.user_dashboard_pref set layout = '{"v":9,"widgets":[]}'::jsonb
      where org_id = ${orgA} and user_id = ${userOwnerA}`;
    expect(await loadDashboardPref(ctx)).toBeNull();
  });

  it("reset returns to the default and keeps the row", async () => {
    const ctx = ctxOf(orgA, userOwnerA);
    await saveDashboardPref(ctx, {
      v: 1,
      widgets: [{ key: "my_tasks", size: "s", hidden: false }],
    });
    await resetDashboardPref(ctx);
    expect(await loadDashboardPref(ctx)).toBeNull();
    expect((await rawRow(orgA, userOwnerA))?.layout).toBeNull();
  });

  it("the database refuses a layout that could never be valid", async () => {
    await expect(
      owner`
        update public.user_dashboard_pref set layout = '"just a string"'::jsonb
        where org_id = ${orgA} and user_id = ${userOwnerA}`,
    ).rejects.toThrow();
  });
});

describe("one person's layout is their own", () => {
  it("an administrator cannot read, update or insert a colleague's row", async () => {
    await saveDashboardPref(ctxOf(orgA, userOwnerA), {
      v: 1,
      widgets: [{ key: "attention", size: "l", hidden: false }],
    });
    expect(await rawRow(orgA, userOwnerA)).not.toBeNull();

    // Read: their own blank state, not the owner's.
    expect(await loadDashboardPref(ctxOf(orgA, userAdminA))).toBeNull();
    const visible = (await withCtx(ctxOf(orgA, userAdminA), (tx) =>
      tx.execute(
        sql`select user_id::text as user_id from public.user_dashboard_pref where org_id = ${orgA}`,
      ),
    )) as unknown as Array<{ user_id: string }>;
    expect(visible.map((r) => r.user_id)).not.toContain(userOwnerA);

    // Update: matches nothing.
    await withCtx(ctxOf(orgA, userAdminA), async (tx) => {
      await tx.execute(sql`
        update public.user_dashboard_pref set layout = '{"v":1,"widgets":[]}'::jsonb
        where org_id = ${orgA} and user_id = ${userOwnerA}`);
    });
    const after = (await rawRow(orgA, userOwnerA))?.layout as { widgets: unknown[] };
    expect(after.widgets).toHaveLength(1);

    // Insert on somebody's behalf: refused by the policy.
    await expect(
      withCtx(ctxOf(orgA, userAdminA), async (tx) => {
        await tx.execute(sql`
          insert into public.user_dashboard_pref (org_id, user_id, layout)
          values (${orgA}, ${userOwnerA}, null)`);
      }),
    ).rejects.toThrow();
  });

  it("another company sees nothing, and a forged org id writes nothing", async () => {
    const rows = (await withCtx(ctxOf(orgB, userOwnerB), (tx) =>
      tx.execute(sql`select count(*)::int as n from public.user_dashboard_pref`),
    )) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(0);
    await expect(
      withCtx(ctxOf(randomUUID(), userOwnerA), async (tx) => {
        await tx.execute(sql`
          insert into public.user_dashboard_pref (org_id, user_id, layout)
          values (${randomUUID()}, ${userOwnerA}, null)`);
      }),
    ).rejects.toThrow();
  });

  it("writes no audit rows", async () => {
    const count = async () =>
      (
        (await owner`select count(*)::int as n from public.audit_log where org_id = ${orgA}`) as unknown as Array<{
          n: number;
        }>
      )[0]!.n;
    const before = await count();
    await saveDashboardPref(ctxOf(orgA, userOwnerA), { v: 1, widgets: [] });
    await resetDashboardPref(ctxOf(orgA, userOwnerA));
    expect(await count()).toBe(before);
  });
});
