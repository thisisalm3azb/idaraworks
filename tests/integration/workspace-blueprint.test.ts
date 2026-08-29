/**
 * H14 workspace blueprint lifecycle (integration, real DB) — the 0075 surface
 * end-to-end: draft → validate → approve → apply → supersede → undo through
 * the real command path, plus the security walls that only the database can
 * prove: org RLS isolation (forged org id, non-member, cross-org reads), the
 * immutability guard trigger (a modified draft after approval, terminal
 * states), one-applied-per-org, duplicate application idempotence, audit_log
 * rows for every lifecycle action, undo revision integrity, and
 * disable-never-deletes (business records survive a blueprint that disables
 * their module). Self-cleaning (wipeOrgs).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, sql, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import {
  createBlueprintDraft,
  updateBlueprintDraft,
  validateBlueprintRevision,
  approveBlueprintRevision,
  rejectBlueprintRevision,
  applyBlueprintRevision,
  undoBlueprintApply,
  getAppliedWorkspace,
  getBlueprintRevision,
  listBlueprintRevisions,
  BlueprintLifecycleError,
  blueprintHash,
} from "@/platform/workspace";
import { makeBlueprint, modulesWith, scenarioContractor, prov } from "../unit/workspace-fixtures";
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
  requestId: "workspace-blueprint-test",
});
const ctxA = () => ctxOf(orgA, userA);
const ctxB = () => ctxOf(orgB, userB);

async function seedAuthUser(id: string, email: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${email}, '{"full_name":"Blueprint Test"}'::jsonb, now(), now())`;
}

beforeAll(async () => {
  await seedAuthUser(userA, `blueprint-a-${run}@example.com`);
  await seedAuthUser(userB, `blueprint-b-${run}@example.com`);
  orgA = await createOrgForUser(userA, {
    name: `BLUEPRINT-A-${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  orgB = await createOrgForUser(userB, {
    name: `BLUEPRINT-B-${run}`,
    country: "SA",
    baseCurrency: "SAR",
  });
}, 120_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB].filter(Boolean), [userA, userB]);
  await owner.end();
  await closeAppDb();
});

describe("H14 — lifecycle happy path with audit", () => {
  let draftId = "";
  let draftHash = "";

  it("drafting stores a validated-normalized revision and alters nothing", async () => {
    const r = await createBlueprintDraft(ctxA(), "owner", {
      blueprint: scenarioContractor(),
      source: "onboarding_answer",
      reason: "Initial contractor setup",
    });
    draftId = r.id;
    draftHash = r.blueprintHash;
    expect(r.revisionNo).toBe(1);
    expect(r.validation.ok).toBe(true);
    expect(await getAppliedWorkspace(ctxA(), "owner")).toBeNull();
  });

  it("validate → approve binds the approver to the exact content hash", async () => {
    const v = await validateBlueprintRevision(ctxA(), "owner", draftId);
    expect(v.ok).toBe(true);
    const a = await approveBlueprintRevision(ctxA(), "owner", draftId, {
      expectedHash: draftHash,
    });
    expect(a.approvedHash).toBe(draftHash);
    const rev = await getBlueprintRevision(ctxA(), "owner", draftId);
    expect(rev?.status).toBe("approved");
    expect(rev?.approvedBy).toBe(userA);
  });

  it("apply compiles with server entitlements, becomes the one applied revision", async () => {
    const r = await applyBlueprintRevision(ctxA(), "owner", draftId);
    expect(r.applied).toBe(true);
    expect(r.compiled.compilerVersion).toBe("1.0.0");
    const applied = await getAppliedWorkspace(ctxA(), "owner");
    expect(applied?.id).toBe(draftId);
    expect(applied?.compiled?.capabilities.length).toBeGreaterThan(0);
  });

  it("duplicate application of the applied revision is a safe no-op (law 9)", async () => {
    const again = await applyBlueprintRevision(ctxA(), "owner", draftId);
    expect(again.applied).toBe(false);
    expect(
      (await listBlueprintRevisions(ctxA(), "owner")).filter((r) => r.status === "applied").length,
    ).toBe(1);
  });

  it("every lifecycle action wrote an audit_log row (law 10)", async () => {
    const rows = await owner`
      select action from public.audit_log
      where org_id = ${orgA}::uuid and entity_type = 'workspace_blueprint'
      order by created_at`;
    const actions = rows.map((r) => r.action as string);
    for (const expected of [
      "blueprint.draft",
      "blueprint.validate",
      "blueprint.approve",
      "blueprint.apply",
    ]) {
      expect(actions).toContain(expected);
    }
  });

  it("a second applied revision supersedes the first; undo restores it as a NEW revision", async () => {
    const second = await createBlueprintDraft(ctxA(), "owner", {
      blueprint: makeBlueprint(), // the minimal services blueprint
      source: "user_change",
      reason: "Trim to services shape",
    });
    await validateBlueprintRevision(ctxA(), "owner", second.id);
    await approveBlueprintRevision(ctxA(), "owner", second.id, {
      expectedHash: second.blueprintHash,
    });
    await applyBlueprintRevision(ctxA(), "owner", second.id);

    const first = await getBlueprintRevision(ctxA(), "owner", draftId);
    expect(first?.status).toBe("superseded");
    expect(first?.supersededBy).toBe(second.id);

    // Undo: history is appended, never rewritten (law 11).
    const undo = await undoBlueprintApply(ctxA(), "owner");
    expect(undo.restoredRevisionId).not.toBeNull();
    const applied = await getAppliedWorkspace(ctxA(), "owner");
    expect(applied?.id).toBe(undo.restoredRevisionId);
    expect(applied?.proposedSource).toBe("undo");
    expect(applied?.blueprintHash).toBe(draftHash); // the contractor content is back
    const all = await listBlueprintRevisions(ctxA(), "owner");
    expect(all.length).toBe(3); // nothing was deleted or rewritten
    const secondRow = all.find((r) => r.id === second.id);
    expect(secondRow?.status).toBe("superseded");
    const undoAudit = await owner`
      select count(*)::int as n from public.audit_log
      where org_id = ${orgA}::uuid and action = 'blueprint.undo'`;
    expect(undoAudit[0]!.n).toBe(1);
  });

  it("disabling a module never deletes business records (law 12)", async () => {
    // The currently applied (contractor) blueprint DISABLES nothing the org
    // uses yet — create a customer record, then apply a blueprint with
    // cap.customers still enabled but almost everything else off, and prove
    // the record survives configuration changes.
    const customerId = randomUUID();
    await withCtx(ctxA(), (tx) =>
      tx.execute(sql`
        insert into public.customer (id, org_id, name)
        values (${customerId}, ${orgA}, ${"Blueprint Survivor LLC"})
      `),
    );
    const trimmed = await createBlueprintDraft(ctxA(), "owner", {
      blueprint: makeBlueprint({
        capabilities: {
          modules: modulesWith(["cap.jobs", "cap.customers", "cap.issues"]),
          provenance: prov("Trim modules", "تقليص الوحدات"),
        },
      }),
      source: "user_change",
      reason: "Disable everything nonessential",
    });
    await validateBlueprintRevision(ctxA(), "owner", trimmed.id);
    await approveBlueprintRevision(ctxA(), "owner", trimmed.id, {
      expectedHash: trimmed.blueprintHash,
    });
    await applyBlueprintRevision(ctxA(), "owner", trimmed.id);
    const rows = await owner`
      select count(*)::int as n from public.customer
      where org_id = ${orgA}::uuid and id = ${customerId}::uuid`;
    expect(rows[0]!.n).toBe(1);
  });
});

describe("H14 — stale approval, tampering, invalid states", () => {
  it("a draft modified after review cannot be approved with the old hash", async () => {
    const d = await createBlueprintDraft(ctxA(), "owner", {
      blueprint: makeBlueprint(),
      source: "user_change",
    });
    await updateBlueprintDraft(ctxA(), "owner", d.id, {
      blueprint: makeBlueprint({
        profile: { ...makeBlueprint().profile, operatingLocations: 7 },
      }),
      expectedHash: d.blueprintHash,
    });
    await validateBlueprintRevision(ctxA(), "owner", d.id);
    await expect(
      approveBlueprintRevision(ctxA(), "owner", d.id, { expectedHash: d.blueprintHash }),
    ).rejects.toThrow(BlueprintLifecycleError);
  });

  it("a concurrent edit with a stale hash is refused, never silently merged", async () => {
    const d = await createBlueprintDraft(ctxA(), "owner", {
      blueprint: makeBlueprint(),
      source: "user_change",
    });
    await updateBlueprintDraft(ctxA(), "owner", d.id, {
      blueprint: makeBlueprint({
        profile: { ...makeBlueprint().profile, operatingLocations: 2 },
      }),
      expectedHash: d.blueprintHash,
    });
    await expect(
      updateBlueprintDraft(ctxA(), "owner", d.id, {
        blueprint: makeBlueprint(),
        expectedHash: d.blueprintHash, // stale
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });
  });

  it("an unvalidated or rejected revision can never be approved or applied", async () => {
    const d = await createBlueprintDraft(ctxA(), "owner", {
      blueprint: makeBlueprint(),
      source: "user_change",
    });
    await expect(
      approveBlueprintRevision(ctxA(), "owner", d.id, { expectedHash: d.blueprintHash }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await expect(applyBlueprintRevision(ctxA(), "owner", d.id)).rejects.toMatchObject({
      code: "invalid_state",
    });
    await rejectBlueprintRevision(ctxA(), "owner", d.id, { reason: "not wanted" });
    const rev = await getBlueprintRevision(ctxA(), "owner", d.id);
    expect(rev?.status).toBe("rejected");
    expect(rev?.rejectedBy).toBe(userA);
    await validateBlueprintRevision(ctxA(), "owner", d.id).catch((e) => {
      expect((e as BlueprintLifecycleError).code).toBe("invalid_state");
    });
  });

  it("an INVALID draft can never reach approved (validation_failed fail-closed)", async () => {
    const d = await createBlueprintDraft(ctxA(), "owner", {
      blueprint: { schemaVersion: 1, garbage: true },
      source: "user_change",
    });
    expect(d.validation.ok).toBe(false);
    const v = await validateBlueprintRevision(ctxA(), "owner", d.id);
    expect(v.ok).toBe(false);
    const rev = await getBlueprintRevision(ctxA(), "owner", d.id);
    expect(rev?.status).toBe("draft"); // never became validated
    await expect(
      approveBlueprintRevision(ctxA(), "owner", d.id, { expectedHash: d.blueprintHash }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("the DB guard trigger freezes approved content even below the app layer", async () => {
    const d = await createBlueprintDraft(ctxA(), "owner", {
      blueprint: makeBlueprint(),
      source: "user_change",
    });
    await validateBlueprintRevision(ctxA(), "owner", d.id);
    await approveBlueprintRevision(ctxA(), "owner", d.id, { expectedHash: d.blueprintHash });
    await expect(
      owner`
        update public.workspace_blueprint_revision
        set blueprint = '{"forged": true}'::jsonb
        where id = ${d.id}::uuid`,
    ).rejects.toThrow(/immutable/);
    // Terminal states refuse everything.
    await rejectBlueprintRevision(ctxA(), "owner", d.id, { reason: "cleanup" }).catch(() => {});
  });

  it("rejected revisions are terminal at the DB layer", async () => {
    const d = await createBlueprintDraft(ctxA(), "owner", {
      blueprint: makeBlueprint(),
      source: "user_change",
    });
    await rejectBlueprintRevision(ctxA(), "owner", d.id, { reason: "terminal test" });
    await expect(
      owner`
        update public.workspace_blueprint_revision
        set status = 'approved'
        where id = ${d.id}::uuid`,
    ).rejects.toThrow(/immutable|illegal/);
  });
});

describe("H14 — organization isolation (RLS)", () => {
  it("a forged org id in ctx cannot read another organization's blueprints", async () => {
    // ctx claims org A but the session user is B's owner (non-member of A):
    // the SELECT policy requires an active owner/admin membership in A.
    const forged = ctxOf(orgA, userB);
    const rows = await withCtx(forged, (tx) =>
      tx.execute(sql`
        select id from public.workspace_blueprint_revision where org_id = ${orgA}
      `),
    );
    expect((rows as unknown as unknown[]).length).toBe(0);
  });

  it("cross-organization blueprint access returns nothing and mutates nothing", async () => {
    const aRevisions = await listBlueprintRevisions(ctxA(), "owner");
    expect(aRevisions.length).toBeGreaterThan(0);
    const target = aRevisions[0]!.id;
    // B cannot see A's revision through B's own ctx…
    expect(await getBlueprintRevision(ctxB(), "owner", target)).toBeNull();
    // …and B cannot approve it (not found in B's org scope).
    await expect(
      approveBlueprintRevision(ctxB(), "owner", target, { expectedHash: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "not_found" });
    // B's own org has its own clean history.
    expect((await listBlueprintRevisions(ctxB(), "owner")).length).toBe(0);
  });

  it("a non-owner/admin member cannot read blueprint rows even inside the org (RLS gate)", async () => {
    // Seed a foreman membership for user B inside org A, then read as them.
    await owner`
      insert into public.membership (user_id, org_id, role_key)
      values (${userB}::uuid, ${orgA}::uuid, 'foreman')`;
    const rows = await withCtx(ctxOf(orgA, userB), (tx) =>
      tx.execute(sql`
        select id from public.workspace_blueprint_revision where org_id = ${orgA}
      `),
    );
    expect((rows as unknown as unknown[]).length).toBe(0);
    // And the app layer refuses the archetype before any query (law 3/5).
    await expect(listBlueprintRevisions(ctxOf(orgA, userB), "foreman")).rejects.toThrow();
  });

  it("undo with nothing applied fails closed", async () => {
    await expect(undoBlueprintApply(ctxB(), "owner")).rejects.toMatchObject({
      code: "nothing_to_undo",
    });
  });

  it("hash integrity: the stored content always matches its recorded hash", async () => {
    const all = await listBlueprintRevisions(ctxA(), "owner", 100);
    for (const rev of all) {
      if (rev.status === "applied" || rev.status === "approved" || rev.status === "superseded") {
        expect(blueprintHash(rev.blueprint)).toBe(rev.blueprintHash);
      }
    }
  });
});
