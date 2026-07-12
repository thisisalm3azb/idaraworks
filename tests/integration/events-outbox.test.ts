/**
 * Transactional outbox + relay integration (Phase G): event emission atomic with
 * the mutation, the platform-task relay (claim → send → mark), dead-letter,
 * retention, the no-org-context guard, and tenant isolation of the bus.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, withCtx, type Ctx } from "@/platform/tenancy";
import { command } from "@/platform/audit";
import {
  relayOutbox,
  checkDeadLetters,
  purgeProcessedEvents,
  redriveDeadLetters,
  MAX_ATTEMPTS,
  type SendFn,
} from "@/platform/events";
import { createOrgForUser } from "@/platform/auth/identity";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";

async function seedAuthUser(id: string, email: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${email}, '{"full_name":"x"}'::jsonb, now(), now())`;
}

beforeAll(async () => {
  await seedAuthUser(userA, `evt-a-${run}@example.com`);
  await seedAuthUser(userB, `evt-b-${run}@example.com`);
  orgA = await createOrgForUser(userA, { name: "Evt A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "Evt B", country: "SA", baseCurrency: "SAR" });
}, 90_000);

afterAll(async () => {
  for (const org of [orgA, orgB].filter(Boolean)) {
    await owner`delete from public.domain_event where org_id = ${org}`;
    await owner`delete from public.audit_log where org_id = ${org}`;
    await owner`delete from public.org_plan_state where org_id = ${org}`;
    await owner`delete from public.membership where org_id = ${org}`;
    await owner`delete from public.role_definition where org_id = ${org}`;
    await owner`delete from public.company where org_id = ${org}`;
    await owner`delete from public.org where id = ${org}`;
  }
  await owner`delete from public.user_profile where id = any(${[userA, userB]}::uuid[])`;
  await owner`delete from auth.users where id = any(${[userA, userB]}::uuid[])`;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: false,
  pricePrivileged: false,
  requestId: "evt",
});

function nonce(): string {
  return `n-${randomUUID().slice(0, 12)}`;
}

async function unprocessedCount(org: string): Promise<number> {
  const [r] = await owner`
    select count(*)::int as n from public.domain_event where org_id = ${org} and processed_at is null`;
  return r!.n;
}

describe("emission is atomic with the mutation (command events)", () => {
  it("commits the event with the audit + mutation", async () => {
    const n = nonce();
    await command(
      ctxOf(orgA, userA),
      {
        audit: { action: "test.emit", entityType: "org", summary: "emit test" },
        events: [{ name: "demo/heartbeat", payload: { nonce: n } }],
      },
      async () => undefined,
    );
    const [row] = await owner`
      select name, version, payload->>'nonce' as nonce, actor_user_id::text as actor
      from public.domain_event where org_id = ${orgA} and payload->>'nonce' = ${n}`;
    expect(row!.name).toBe("demo/heartbeat");
    expect(row!.version).toBe(1);
    expect(row!.actor).toBe(userA);
  });

  it("rolls the event back when the mutation throws (no phantom event)", async () => {
    const n = nonce();
    await expect(
      command(
        ctxOf(orgA, userA),
        {
          audit: { action: "test.emit", entityType: "org", summary: "rollback" },
          events: [{ name: "demo/heartbeat", payload: { nonce: n } }],
        },
        async () => {
          throw new Error("mutation failed");
        },
      ),
    ).rejects.toThrow(/mutation failed/);
    const [row] = await owner`
      select 1 as x from public.domain_event where org_id = ${orgA} and payload->>'nonce' = ${n}`;
    expect(row).toBeUndefined();
  });
});

describe("the relay (platform task)", () => {
  it("claims → sends (keyed by id) → marks processed", async () => {
    const n = nonce();
    await command(
      ctxOf(orgA, userA),
      {
        audit: { action: "test.emit", entityType: "org", summary: "relay" },
        events: [{ name: "demo/heartbeat", payload: { nonce: n } }],
      },
      async () => undefined,
    );

    const sent: Array<{ name: string; id: string }> = [];
    const capture: SendFn = async (e) => {
      sent.push({ name: e.name, id: e.id });
    };
    const result = await relayOutbox(capture, "test");
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.sent).toBe(result.claimed);
    expect(result.failed).toBe(0);
    // Our event was sent keyed by its domain_event id (dedup key).
    const mine = sent.find((s) => s.name === "demo/heartbeat");
    expect(mine).toBeDefined();
    // And is now processed → not re-claimed by a second relay pass.
    const before = await unprocessedCount(orgA);
    const second = await relayOutbox(capture, "test-2");
    expect(await unprocessedCount(orgA)).toBe(before);
    expect(second.claimed).toBe(0);
  });

  it("records an error and leaves the event unprocessed when the send fails", async () => {
    const n = nonce();
    await command(
      ctxOf(orgA, userA),
      {
        audit: { action: "test.emit", entityType: "org", summary: "fail" },
        events: [{ name: "demo/heartbeat", payload: { nonce: n } }],
      },
      async () => undefined,
    );
    const failing: SendFn = async () => {
      throw new Error("inngest down");
    };
    const result = await relayOutbox(failing, "test-fail");
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const [row] = await owner`
      select processed_at, attempts, last_error from public.domain_event
      where org_id = ${orgA} and payload->>'nonce' = ${n}`;
    expect(row!.processed_at).toBeNull(); // still unprocessed → will retry
    expect(Number(row!.attempts)).toBeGreaterThanOrEqual(1);
    expect(row!.last_error).toContain("inngest down");
    // tidy: mark processed so it doesn't pollute later counts
    await owner`update public.domain_event set processed_at = now() where org_id = ${orgA} and payload->>'nonce' = ${n}`;
  });
});

describe("dead-letter + retention", () => {
  it("surfaces events that exhausted their attempts", async () => {
    const n = nonce();
    await command(
      ctxOf(orgA, userA),
      {
        audit: { action: "test.emit", entityType: "org", summary: "dead" },
        events: [{ name: "demo/heartbeat", payload: { nonce: n } }],
      },
      async () => undefined,
    );
    // Force it past the max-attempts threshold.
    await owner`update public.domain_event set attempts = ${MAX_ATTEMPTS} where org_id = ${orgA} and payload->>'nonce' = ${n}`;
    const dead = await checkDeadLetters("test");
    expect(dead).toBeGreaterThanOrEqual(1);
    // the relay skips it (attempts >= max) — not re-claimed
    const claimed = await relayOutbox(async () => undefined, "test");
    const [row] = await owner`
      select attempts from public.domain_event where org_id = ${orgA} and payload->>'nonce' = ${n}`;
    expect(Number(row!.attempts)).toBe(MAX_ATTEMPTS); // untouched by the relay
    void claimed;
    await owner`update public.domain_event set processed_at = now() where org_id = ${orgA} and payload->>'nonce' = ${n}`;
  });

  it("purge removes processed events older than the window", async () => {
    const n = nonce();
    await command(
      ctxOf(orgA, userA),
      {
        audit: { action: "test.emit", entityType: "org", summary: "purge" },
        events: [{ name: "demo/heartbeat", payload: { nonce: n } }],
      },
      async () => undefined,
    );
    await owner`
      update public.domain_event set processed_at = now() - interval '100 days'
      where org_id = ${orgA} and payload->>'nonce' = ${n}`;
    const purged = await purgeProcessedEvents("90 days", "test");
    expect(purged.processed).toBeGreaterThanOrEqual(1);
    const [row] = await owner`
      select 1 as x from public.domain_event where org_id = ${orgA} and payload->>'nonce' = ${n}`;
    expect(row).toBeUndefined();
  });

  it("redrive resets a dead-lettered event so it retries (ops recovery, 0015)", async () => {
    const n = nonce();
    await command(
      ctxOf(orgA, userA),
      {
        audit: { action: "test.emit", entityType: "org", summary: "redrive" },
        events: [{ name: "demo/heartbeat", payload: { nonce: n } }],
      },
      async () => undefined,
    );
    await owner`update public.domain_event set attempts = 20, last_error = 'boom'
      where org_id = ${orgA} and payload->>'nonce' = ${n}`;
    const redriven = await redriveDeadLetters("test");
    expect(redriven).toBeGreaterThanOrEqual(1);
    const [row] = await owner`
      select attempts, last_error from public.domain_event
      where org_id = ${orgA} and payload->>'nonce' = ${n}`;
    expect(Number(row!.attempts)).toBe(0);
    expect(row!.last_error).toBeNull();
    await owner`update public.domain_event set processed_at = now() where org_id = ${orgA} and payload->>'nonce' = ${n}`;
  });
});

describe("security boundary", () => {
  it("the relay functions REFUSE to run inside an org context", async () => {
    // A tenant request always has the org GUC set (withCtx) → the platform-task
    // guard must reject a claim, so a tenant can never read cross-org events. The
    // RAISE aborts the tx and escapes at the withCtx boundary — catch it there.
    const err = await withCtx(ctxOf(orgA, userA), (tx) =>
      tx.execute(sql`select * from app.claim_domain_events(10, 5)`),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err, "expected the platform-task guard to reject").toBeInstanceOf(Error);
    const cause = (err as { message?: string; cause?: { message?: string } }).cause;
    expect(`${(err as Error).message} ${cause?.message ?? ""}`).toMatch(/platform task only/i);
  });

  it("a tenant cannot SELECT the domain_event bus (no grant + RLS default-deny)", async () => {
    // 0015 revoked the SELECT grant → app_user gets a hard privilege error, not
    // just an empty result. Belt (grant) AND braces (RLS).
    const err = await withCtx(ctxOf(orgA, userA), (tx) =>
      tx.execute(sql`select count(*) from public.domain_event`),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const code = (err as { code?: string; cause?: { code?: string } }).cause?.code;
    expect(code).toBe("42501"); // insufficient_privilege
  });

  it("org B never sees org A's events (owner-level cross check)", async () => {
    expect(await unprocessedCount(orgB)).toBe(0);
  });
});
