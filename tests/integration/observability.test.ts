/**
 * Phase I integration: health probes against the real stack, and the
 * app.outbox_stats platform surface (0018) — correctness + the platform-task
 * guard (a tenant session must NEVER read queue gauges).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, createAppDb, sql, withCtx, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { MAX_ATTEMPTS } from "@/platform/events";
import { healthReport } from "@/platform/observability/health";
import { ownerSql } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userId = randomUUID();
let orgId = "";

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`obs-${run}@example.com`}, '{"full_name":"x"}'::jsonb, now(), now())`;
  orgId = await createOrgForUser(userId, { name: "Obs", country: "AE", baseCurrency: "AED" });
}, 120_000);

afterAll(async () => {
  await owner`delete from public.domain_event where org_id = ${orgId}`;
  // FK order: membership references role_definition — delete members first.
  for (const t of [
    "audit_log",
    "activity",
    "app_settings",
    "sign_in_log",
    "org_plan_state",
    "membership",
    "role_definition",
    "company",
  ]) {
    await owner.unsafe(`delete from public.${t} where org_id = $1`, [orgId]);
  }
  await owner`delete from public.org where id = ${orgId}`;
  await owner`delete from public.user_profile where id = ${userId}`;
  await owner`delete from auth.users where id = ${userId}`;
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

const ctxOf = (): Ctx => ({
  orgId,
  userId,
  costPrivileged: false,
  pricePrivileged: false,
  requestId: "obs-test",
});

describe("app.outbox_stats (0018)", () => {
  it("counts unprocessed and dead-lettered events from a PLATFORM session", async () => {
    // Baseline, then seed 2 fresh + 1 dead-lettered event for a known org.
    await owner`
      insert into public.domain_event (org_id, name, payload, actor_user_id)
      values (${orgId}, 'demo/heartbeat', '{}'::jsonb, ${userId}),
             (${orgId}, 'demo/heartbeat', '{}'::jsonb, ${userId})`;
    await owner`
      insert into public.domain_event (org_id, name, payload, actor_user_id, attempts)
      values (${orgId}, 'demo/heartbeat', '{}'::jsonb, ${userId}, ${MAX_ATTEMPTS})`;

    const client = createAppDb({ max: 1 });
    try {
      const rows = (await client.db.execute(sql`
        select unprocessed::int as unprocessed,
               oldest_unprocessed_age_s::int as oldest_age,
               dead_lettered::int as dead_lettered
        from app.outbox_stats(${MAX_ATTEMPTS})`)) as unknown as Array<{
        unprocessed: number;
        oldest_age: number;
        dead_lettered: number;
      }>;
      const s = rows[0]!;
      expect(s.unprocessed).toBeGreaterThanOrEqual(2);
      expect(s.dead_lettered).toBeGreaterThanOrEqual(1);
      expect(s.oldest_age).toBeGreaterThanOrEqual(0);
    } finally {
      await client.end();
    }
  });

  it("REJECTS a tenant (org-ctx) session — platform-task guard", async () => {
    const failure = await withCtx(ctxOf(), (tx) =>
      tx.execute(sql`select * from app.outbox_stats(${MAX_ATTEMPTS})`),
    ).then(
      () => null,
      (e: unknown) => e as Error & { cause?: { message?: string } },
    );
    expect(failure, "tenant session must not read outbox stats").not.toBeNull();
    expect(failure!.cause?.message ?? failure!.message).toMatch(/platform task only/i);
  });
});

describe("healthReport (Phase I; Bible §15.5)", () => {
  it("reports per-dependency truth against the real stack", async () => {
    const rid = randomUUID();
    const report = await healthReport(rid);
    expect(report.request_id).toBe(rid);
    expect(report.checks.db.ok).toBe(true);
    expect(report.checks.storage.ok).toBe(true);
    expect(report.checks.queue.ok).toBe(true);
    expect(typeof report.checks.queue.unprocessed).toBe("number");
    expect(typeof report.checks.queue.dead_lettered).toBe("number");
    // Keys are not provisioned in test envs — the status must be EXPLICIT.
    expect(report.checks.inngest.status).toBe("unconfigured");
    expect(report.ok).toBe(true);
    // The seeded dead-letter above must surface as the page-worthy alert flag.
    expect(report.checks.queue.alert).toBe(true);
  }, 30_000);
});
