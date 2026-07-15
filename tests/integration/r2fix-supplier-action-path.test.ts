/**
 * DEFECT-3 — ACTION-level proof (not just the service). Drives the REAL
 * createSupplierAction (the deployed server action) against a template-applied
 * synthetic org, mocking only the request-bound seams the action can't have in a
 * test: resolveCtxForAction (needs a cookie session), next/navigation.redirect
 * and next/cache.revalidatePath. Proves:
 *   - SUCCESS: the action creates the supplier and redirects to the clean list
 *     URL (no ?error) — the row appears (what revalidatePath surfaces in prod);
 *   - FAILURE: a bad email is caught and redirected to the form with a SPECIFIC
 *     code + correlation id + the submitted values preserved (form not wiped).
 *
 * Hosted DB, self-cleaning, synthetic org only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { startOnboarding, applyOnboarding } from "@/modules/onboarding/service";
import { listSuppliers } from "@/modules/masters/service";
import { ownerSql, wipeOrgs } from "./helpers";

// ── mocked request-bound seams ────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  resolved: null as unknown,
  RedirectSignal: class RedirectSignal extends Error {
    constructor(public url: string) {
      super(`REDIRECT ${url}`);
    }
  },
}));
vi.mock("@/platform/auth/resolve", () => ({
  resolveCtxForAction: async () => h.resolved,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new h.RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// Imported AFTER the mocks are declared (vi.mock is hoisted above imports).
import { createSupplierAction } from "@/app/(app)/o/[orgId]/suppliers/actions";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const ownerUser = randomUUID();
const orgIds: string[] = [];
let orgId = "";

const ctx = (): Ctx => ({
  orgId,
  userId: ownerUser,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: `r2fix-action-${run}`,
});

/** Capture the redirect URL the action throws. */
async function runAction(fd: FormData): Promise<string> {
  try {
    await createSupplierAction(orgId, fd);
    throw new Error("action did not redirect");
  } catch (err) {
    if (err instanceof h.RedirectSignal) return err.url;
    throw err;
  }
}

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${ownerUser}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`r2fix-action-${run}@example.com`}, '{"full_name":"R2FIX Action"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(ownerUser, {
    name: "R2FIX Action Org",
    country: "AE",
    baseCurrency: "AED",
  });
  orgIds.push(orgId);
  const started = await startOnboarding(ctx(), "owner", {
    business_name: "R2FIX Action Org",
    business_description: "fit-out contractor in dubai",
    template_key: "construction_v1",
    country: "AE",
    base_currency: "AED",
    languages: ["en", "ar"],
    six_day_week: true,
    vat_registered: true,
    requested_features: [],
  });
  await applyOnboarding(ctx(), "owner", started.sessionId);
  h.resolved = { ctx: ctx(), archetype: "owner", roleKey: "owner" };
}, 180_000);

afterAll(async () => {
  await wipeOrgs(owner, orgIds, [ownerUser]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 60_000);

describe("createSupplierAction — deployed code path", () => {
  it("SUCCESS: creates the supplier and redirects to the clean list URL", async () => {
    const fd = new FormData();
    fd.set("name", `Action Sub ${run}`);
    fd.set("tax_reg_no", "100111222300003");
    fd.set("phone", "+971500000000");
    fd.set("email", "ok@action.example");

    const url = await runAction(fd);
    expect(url).toBe(`/o/${orgId}/suppliers`); // no ?error — success
    const list = await listSuppliers(ctx(), "owner");
    expect(list.some((s) => s.name === `Action Sub ${run}`)).toBe(true);
  });

  it("FAILURE: a bad email redirects with a specific code + ref + preserved values", async () => {
    const fd = new FormData();
    fd.set("name", `Kept Name ${run}`);
    fd.set("tax_reg_no", "100999");
    fd.set("phone", "+971511111111");
    fd.set("email", "not-an-email");

    const url = await runAction(fd);
    const qs = new URL(url, "https://x").searchParams;
    expect(qs.get("error")).toBe("invalid_email");
    expect(qs.get("field")).toBe("email");
    expect(qs.get("ref")).toBeTruthy(); // correlation id present
    // Form NOT wiped — the submitted values are echoed back.
    expect(qs.get("name")).toBe(`Kept Name ${run}`);
    expect(qs.get("email")).toBe("not-an-email");
    expect(qs.get("tax_reg_no")).toBe("100999");

    // And nothing was written for the failed submit.
    const list = await listSuppliers(ctx(), "owner");
    expect(list.some((s) => s.name === `Kept Name ${run}`)).toBe(false);
  });
});
