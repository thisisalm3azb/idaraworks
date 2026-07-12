/**
 * Phase F integration: comment / notification / notification_preference /
 * config_revision RLS + two-org isolation + append-only, plus the terminology
 * override read scoped per org. Real hosted DB (or CI local stack).
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, type Ctx } from "@/platform/tenancy";
import { createComment, listComments, softDeleteComment, CommentError } from "@/platform/comments";
import {
  createNotification,
  listMyNotifications,
  markNotificationRead,
  getMyNotificationPreferences,
  setMyNotificationPreferences,
} from "@/platform/notifications";
import { recordConfigRevision } from "@/platform/config";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { createOrgForUser, inviteMember, acceptInvite } from "@/platform/auth/identity";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID(); // org A owner
const userB = randomUUID(); // org B owner
const userC = randomUUID(); // org A manager (second member, for recipient scoping)
let orgA = "";
let orgB = "";

async function seedAuthUser(id: string, email: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${email}, '{"full_name":"x"}'::jsonb, now(), now())`;
}

const emailC = `cc-c-${run}@example.com`;

beforeAll(async () => {
  await seedAuthUser(userA, `cc-a-${run}@example.com`);
  await seedAuthUser(userB, `cc-b-${run}@example.com`);
  await seedAuthUser(userC, emailC);
  orgA = await createOrgForUser(userA, { name: "Comms A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "Comms B", country: "SA", baseCurrency: "SAR" });
  const { token } = await inviteMember(ctxOf(orgA, userA), "owner", {
    email: emailC,
    roleKey: "manager",
  });
  await acceptInvite(userC, token);
}, 90_000);

afterAll(async () => {
  for (const org of [orgA, orgB].filter(Boolean)) {
    await owner`delete from public.config_revision where org_id = ${org}`;
    await owner`delete from public.comment where org_id = ${org}`;
    await owner`delete from public.notification where org_id = ${org}`;
    await owner`delete from public.notification_preference where org_id = ${org}`;
    await owner`delete from public.app_settings where org_id = ${org}`;
    await owner`delete from public.activity where org_id = ${org}`;
    await owner`delete from public.audit_log where org_id = ${org}`;
    await owner`delete from public.org_plan_state where org_id = ${org}`;
    await owner`delete from public.membership_invite where org_id = ${org}`;
    await owner`delete from public.membership where org_id = ${org}`;
    await owner`delete from public.role_definition where org_id = ${org}`;
    await owner`delete from public.company where org_id = ${org}`;
    await owner`delete from public.org where id = ${org}`;
  }
  await owner`delete from public.user_profile where id = any(${[userA, userB, userC]}::uuid[])`;
  await owner`delete from auth.users where id = any(${[userA, userB, userC]}::uuid[])`;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

function ctxOf(orgId: string, userId: string): Ctx {
  return { orgId, userId, costPrivileged: false, pricePrivileged: false, requestId: "cc" };
}

async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!err) return undefined;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}

const jobId = randomUUID(); // a synthetic job entity id (job table lands S1)

describe("comments", () => {
  it("creates, lists, and writes an activity row", async () => {
    const id = await createComment(ctxOf(orgA, userA), {
      entityType: "job",
      entityId: jobId,
      body: "First inspection done.",
    });
    expect(id).toBeTruthy();
    const list = await listComments(ctxOf(orgA, userA), "job", jobId);
    expect(list.map((c) => c.body)).toContain("First inspection done.");
    const [act] = await owner`
      select verb from public.activity where org_id = ${orgA} and entity_id = ${jobId} and verb = 'commented'`;
    expect(act).toBeDefined();
  });

  it("only the author may soft-delete; deleted rows drop from the default list", async () => {
    const id = await createComment(ctxOf(orgA, userA), {
      entityType: "job",
      entityId: jobId,
      body: "to be removed",
    });
    // userC (co-member, not the author) cannot delete userA's comment
    await expect(softDeleteComment(ctxOf(orgA, userC), id)).rejects.toThrow(CommentError);
    await softDeleteComment(ctxOf(orgA, userA), id);
    const visible = await listComments(ctxOf(orgA, userA), "job", jobId);
    expect(visible.find((c) => c.id === id)).toBeUndefined();
  });

  it("org B cannot see org A's comments", async () => {
    const seen = await listComments(ctxOf(orgB, userB), "job", jobId);
    expect(seen).toHaveLength(0);
  });

  it("DB backstop: a non-author cannot edit/soft-delete another's comment (0013)", async () => {
    const id = await createComment(ctxOf(orgA, userA), {
      entityType: "job",
      entityId: jobId,
      body: "author-only",
    });
    // userC (co-member, not the author) attempting a raw UPDATE is blocked by RLS,
    // not just by the app-layer author check.
    const code = await pgCode(
      withCtx(ctxOf(orgA, userC), (tx) =>
        tx.execute(sql`update public.comment set body = 'tamper' where id = ${id}`),
      ),
    );
    // 42501 (RLS) or 0 rows updated — either way the tamper does not land.
    const [row] = await owner`select body from public.comment where id = ${id}`;
    expect(row!.body).toBe("author-only");
    expect(code === undefined || code === "42501").toBe(true);
  });
});

describe("notifications (recipient-scoped)", () => {
  it("a recipient sees only their own; a co-member does not", async () => {
    await createNotification(ctxOf(orgA, userA), {
      recipientUserId: userC,
      kind: "system",
      title: "Welcome",
    });
    const cSees = await listMyNotifications(ctxOf(orgA, userC));
    expect(cSees.map((n) => n.title)).toContain("Welcome");
    // userA (the actor/sender) is NOT the recipient → cannot see it
    const aSees = await listMyNotifications(ctxOf(orgA, userA));
    expect(aSees.find((n) => n.title === "Welcome")).toBeUndefined();
  });

  it("mark-read updates only the recipient's own row", async () => {
    const { id } = await createNotification(ctxOf(orgA, userA), {
      recipientUserId: userC,
      kind: "system",
      title: "Read me",
    });
    await markNotificationRead(ctxOf(orgA, userC), id);
    const unread = await listMyNotifications(ctxOf(orgA, userC), true);
    expect(unread.find((n) => n.id === id)).toBeUndefined();
  });

  it("preferences are per-user and private", async () => {
    await setMyNotificationPreferences(ctxOf(orgA, userC), {
      system: { in_app: true, email: true },
    });
    const prefs = await getMyNotificationPreferences(ctxOf(orgA, userC));
    expect(prefs.system?.email).toBe(true);
    // userA has no prefs of userC's
    const aPrefs = await getMyNotificationPreferences(ctxOf(orgA, userA));
    expect(aPrefs.system).toBeUndefined();
  });

  it("org B cannot see org A's notifications", async () => {
    const seen = await withCtx(ctxOf(orgB, userB), (tx) =>
      tx.execute(sql`select count(*)::int as n from public.notification`),
    );
    expect((seen as unknown as Array<{ n: number }>)[0]!.n).toBe(0);
  });

  it("a notification cannot be addressed to a non-member (0013 recipient check)", async () => {
    // userB is org B's owner — not a member of org A → insert must be rejected.
    await expect(
      createNotification(ctxOf(orgA, userA), {
        recipientUserId: userB,
        kind: "system",
        title: "stray",
      }),
    ).rejects.toThrow();
  });
});

describe("config_revision (append-only, owner/admin read)", () => {
  it("records a revision + a config.revise audit row atomically", async () => {
    const id = await recordConfigRevision(ctxOf(orgA, userA), {
      artifactKey: "terminology.overrides",
      before: null,
      after: { job: { en: { singular: "Vessel", plural: "Vessels" } } },
      summary: "renamed job → Vessel",
    });
    expect(id).toBeTruthy();
    const [rev] = await owner`
      select artifact_key, ai_flag from public.config_revision where id = ${id}`;
    expect(rev!.artifact_key).toBe("terminology.overrides");
    expect(rev!.ai_flag).toBe(false);
    const [aud] = await owner`
      select action from public.audit_log where org_id = ${orgA} and entity_id = ${id}`;
    expect(aud!.action).toBe("config.revise");
  });

  it("is append-only — app_user cannot UPDATE or DELETE", async () => {
    const upd = await pgCode(
      withCtx(ctxOf(orgA, userA), (tx) =>
        tx.execute(sql`update public.config_revision set summary = 'x' where org_id = ${orgA}`),
      ),
    );
    expect(upd).toBe("42501");
    const del = await pgCode(
      withCtx(ctxOf(orgA, userA), (tx) =>
        tx.execute(sql`delete from public.config_revision where org_id = ${orgA}`),
      ),
    );
    expect(del).toBe("42501");
  });

  it("a non-owner/admin (manager) CAN record a revision — no RETURNING trap (CM2)", async () => {
    // config_revision reads are owner/admin-gated but any member may INSERT; an
    // INSERT ... RETURNING would 42501 for the manager. The app-generated id
    // avoids it, so the S1 config-editor path works for non-admin roles.
    const id = await recordConfigRevision(ctxOf(orgA, userC), {
      artifactKey: "preset.demo",
      before: null,
      after: { x: 1 },
      summary: "manager edit",
    });
    const [rev] = await owner`
      select actor_user_id::text as actor from public.config_revision where id = ${id}`;
    expect(rev!.actor).toBe(userC);
  });

  it("read gated to owner/admin — a manager sees none; org B sees none", async () => {
    const mgr = await withCtx(ctxOf(orgA, userC), (tx) =>
      tx.execute(sql`select count(*)::int as n from public.config_revision`),
    );
    expect((mgr as unknown as Array<{ n: number }>)[0]!.n).toBe(0);
    const bOwner = await withCtx(ctxOf(orgB, userB), (tx) =>
      tx.execute(sql`select count(*)::int as n from public.config_revision`),
    );
    expect((bOwner as unknown as Array<{ n: number }>)[0]!.n).toBe(0);
  });
});

describe("terminology override read (scoped per org, from app_settings)", () => {
  it("resolves an org's override; another org is unaffected", async () => {
    await owner`
      insert into public.app_settings (org_id, key, value)
      values (${orgA}, 'terminology.overrides',
              '{"job":{"en":{"singular":"Vessel","plural":"Vessels"},"ar":{"singular":"سفينة","plural":"سفن","gender":"f"}}}'::jsonb)`;
    await owner`
      insert into public.app_settings (org_id, key, value)
      values (${orgA}, 'terminology.template', '"boat-building"'::jsonb)`;

    const ctxAterms = await loadOrgTerminology(ctxOf(orgA, userA), "en");
    expect(term("job", ctxAterms)).toBe("Vessel"); // override wins over template

    // org B has no override and no template → platform default
    const ctxBterms = await loadOrgTerminology(ctxOf(orgB, userB), "en");
    expect(term("job", ctxBterms)).toBe("Job");
  });
});
