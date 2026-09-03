/**
 * H28A — the gateway on the TEST project: every call is metered (denials
 * included), the organisation policy and allowance govern spend, retries and
 * the breaker are recorded, concurrent calls never double-count, usage pages
 * past the 1,000-row driver cap with totals over the full result, BYOK
 * ciphertext is unreadable to app_user, and assurance tiers never downgrade
 * silently.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 240_000 });
import { createOrgForUser } from "@/platform/auth/identity";
import { closeAppDb, sql, withCtx, type Ctx } from "@/platform/tenancy";
import {
  AdapterError,
  GatewayError,
  aiAvailability,
  invokeModel,
  listUsage,
  allowanceStatus,
  resolveAiPolicy,
  storeByokKeyIn,
  listByokKeys,
  type AiAdapter,
  type GatewayDeps,
  type InvokeArgs,
} from "@/platform/ai";
import { activeByokSecretIn } from "@/platform/ai/byok";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

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
  requestId: "h28a",
});
const A = () => ctxOf(orgA, userA);
const B = () => ctxOf(orgB, userB);

const testEnv = { APP_ENV: "test", AI_DETERMINISTIC_PROVIDER: "1" } as Record<
  string,
  string | undefined
>;
const deps = (over: Partial<GatewayDeps> = {}): GatewayDeps => ({
  env: testEnv,
  sleep: async () => {},
  ...over,
});

async function setPolicy(orgId: string, policy: Record<string, unknown>): Promise<void> {
  const v = (
    await owner`select coalesce(max(version), 0) + 1 as v from public.ai_entitlement where org_id = ${orgId}`
  )[0]!.v as number;
  await owner`insert into public.ai_entitlement (org_id, version, mode, monthly_credits, daily_credit_limit, per_user_daily_credits,
      per_agent_limits, model_allow, max_cost_per_request_credits, soft_warn_pct, hard_stop, overage_allowed, restricted_domains, reason)
    values (${orgId}, ${v}, ${String(policy.mode ?? "trial")}, ${(policy.monthly_credits as number | null) ?? null},
      ${(policy.daily_credit_limit as number | null) ?? null}, ${(policy.per_user_daily_credits as number | null) ?? null},
      ${JSON.stringify(policy.per_agent_limits ?? {})}::jsonb, ${JSON.stringify(policy.model_allow ?? [])}::jsonb,
      ${(policy.max_cost_per_request_credits as number | null) ?? null}, ${(policy.soft_warn_pct as number) ?? 80},
      ${(policy.hard_stop as boolean) ?? true}, ${(policy.overage_allowed as boolean) ?? false},
      ${JSON.stringify(policy.restricted_domains ?? [])}::jsonb, 'h28a test')`;
}

function args(ctx: Ctx, over: Partial<InvokeArgs> = {}): InvokeArgs {
  return {
    ctx,
    agentId: "idara",
    agentDomain: "general",
    agentEnabled: true,
    feature: "agent_run",
    purpose: "h28a",
    taskClass: "answer",
    request: {
      system: "You are a test.",
      blocks: [
        {
          source: "read.customer",
          records: [{ type: "customer", id: randomUUID() }],
          retrievedAt: new Date().toISOString(),
          content: JSON.stringify({ name: "ACME" }),
        },
      ],
      messages: [{ role: "user", content: "Summarise ACME" }],
      maxOutputTokens: 200,
    },
    deps: deps(),
    ...over,
  };
}

beforeAll(async () => {
  for (const [id, name] of [
    [userA, "OwnerA"],
    [userB, "OwnerB"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h28a-${name.toLowerCase()}-${run}@example.invalid`}, ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H28A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "H28A-B", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h28a", run);
  await markFixtureOrg(owner, orgB, "h28a", run);
  // TEST-only synthetic tariff for the deterministic provider so metering has a price to work from.
  await owner`insert into public.ai_price_book (provider_key, model_key, effective_from, currency, input_per_mtok_micros, output_per_mtok_micros, cache_read_per_mtok_micros, note)
    values ('deterministic', 'deterministic:fast', '2020-01-01T00:00:00Z', 'USD', 50000, 400000, 5000, 'h28a synthetic test tariff')
    on conflict (model_key, effective_from) do nothing`;
}, 600_000);

afterAll(async () => {
  await owner`delete from public.ai_price_book where model_key like 'deterministic:%' and note like 'h28a%'`;
  await owner`delete from public.ai_kill_switch where reason like 'h28a%'`;
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end();
  await closeAppDb();
});

describe("policy and denial metering", () => {
  it("with no policy row the organisation is disabled: the call is refused AND recorded", async () => {
    const err = await invokeModel(args(A())).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).failure).toMatchObject({
      kind: "denied",
      verdict: { decision: "deny", reason: "org_mode_disabled" },
    });
    const row = (
      await owner`select status, budget_decision, error, credits, provider, model from public.ai_interaction where id = ${(err as GatewayError).interactionId!}`
    )[0]!;
    expect(row).toMatchObject({
      status: "disabled",
      budget_decision: "deny",
      error: "org_mode_disabled",
      credits: 0,
      provider: "deterministic",
    });
  });

  it("a trial policy with a small allowance allows a metered call, charges credits, writes the ledger and the billing meter", async () => {
    await setPolicy(orgA, { mode: "trial", monthly_credits: 6 });
    const r = await invokeModel(args(A()));
    expect(r.model.key).toBe("deterministic:fast");
    expect(r.credits).toBeGreaterThan(0);
    expect(r.response.content[0]!.kind).toBe("text");
    const row = (
      await owner`select status, budget_decision, credits, est_cost_micros, price_book_id, provider_request_id, latency_ms, agent_id, purpose
                             from public.ai_interaction where id = ${r.interactionId}`
    )[0]!;
    expect(row.status).toBe("ok");
    expect(row.budget_decision).toBe("allow");
    expect(Number(row.credits)).toBe(r.credits);
    expect(row.price_book_id).not.toBeNull();
    expect(String(row.provider_request_id)).toMatch(/^det_/);
    expect(row.agent_id).toBe("idara");
    const ledger =
      await owner`select credits from public.ai_credit_ledger where org_id = ${orgA} and ref_id = ${r.interactionId}`;
    expect(Number(ledger[0]!.credits)).toBe(-r.credits);
    const meter =
      await owner`select delta from public.usage_event where org_id = ${orgA} and meter_key = 'ai_credits' and dedup_key = ${"ai_interaction:" + r.interactionId}`;
    expect(Number(meter[0]!.delta)).toBe(r.credits);
    const status = await withCtx(A(), async (tx) =>
      allowanceStatus(tx, A(), await resolveAiPolicy(tx, A())),
    );
    expect(status.allowance).toBe(6);
    expect(status.consumed).toBe(r.credits);
  });

  it("the allowance exhausts with a hard stop, the denial is recorded, and overage turns it into a warning", async () => {
    let denied: GatewayError | null = null;
    for (let i = 0; i < 12 && !denied; i++) {
      try {
        await invokeModel(args(A()));
      } catch (e) {
        denied = e as GatewayError;
      }
    }
    expect(denied).not.toBeNull();
    expect(denied!.failure).toMatchObject({
      kind: "denied",
      verdict: { reason: "allowance_exhausted", decision: "deny" },
    });
    await setPolicy(orgA, {
      mode: "trial",
      monthly_credits: 6,
      overage_allowed: true,
      hard_stop: false,
    });
    const r = await invokeModel(args(A()));
    const row = (
      await owner`select budget_decision from public.ai_interaction where id = ${r.interactionId}`
    )[0]!;
    expect(row.budget_decision).toBe("warn");
  });

  it("a kill switch stops paid calls before any policy is consulted", async () => {
    await setPolicy(orgA, { mode: "trial", monthly_credits: 1000 });
    await owner`insert into public.ai_kill_switch (scope, scope_key, active, reason, set_by) values ('org', ${orgA}, true, 'h28a org stop', ${userA})`;
    const err = await invokeModel(args(A())).catch((e) => e as GatewayError);
    expect((err as GatewayError).failure).toMatchObject({
      kind: "denied",
      verdict: { decision: "stopped", reason: "org_stop" },
    });
    await owner`update public.ai_kill_switch set active = false, cleared_at = now() where reason = 'h28a org stop'`;
    const avail = await aiAvailability(A(), deps());
    expect(avail.switches.orgStop).toBe(false);
    expect(avail.anyAvailable).toBe(true);
  });
});

describe("assurance tiers and routing", () => {
  it("an analysis task refuses to run on a weaker tier when the strong tier is unavailable, and runs once the strong model is priced", async () => {
    const err = await invokeModel(args(A(), { taskClass: "analyse" })).catch(
      (e) => e as GatewayError,
    );
    expect((err as GatewayError).failure).toMatchObject({
      kind: "unavailable",
      route: "model_unpriced",
    });
    await owner`insert into public.ai_price_book (provider_key, model_key, effective_from, currency, input_per_mtok_micros, output_per_mtok_micros, note)
      values ('deterministic', 'deterministic:strong', '2020-01-01T00:00:00Z', 'USD', 3000000, 15000000, 'h28a synthetic strong tariff')
      on conflict (model_key, effective_from) do nothing`;
    const r = await invokeModel(args(A(), { taskClass: "analyse" }));
    expect(r.model.key).toBe("deterministic:strong");
    expect(r.route.downgraded).toBe(false);
    const cheap = await invokeModel(args(A(), { taskClass: "classify" }));
    expect(cheap.model.key).toBe("deterministic:fast");
  });

  it("a per-request cost cap and a model allow-list deny with recorded reasons", async () => {
    await setPolicy(orgA, {
      mode: "trial",
      monthly_credits: 1000,
      max_cost_per_request_credits: 0,
    });
    const capped = await invokeModel(args(A())).catch((e) => e as GatewayError);
    expect((capped as GatewayError).failure).toMatchObject({
      kind: "denied",
      verdict: { reason: "request_cost_cap" },
    });
    await setPolicy(orgA, {
      mode: "trial",
      monthly_credits: 1000,
      model_allow: ["deterministic:strong"],
    });
    const r = await invokeModel(args(A(), { taskClass: "classify" }));
    expect(r.model.key).toBe("deterministic:strong");
    await setPolicy(orgA, { mode: "trial", monthly_credits: 1000 });
  });
});

describe("external provider failure, retry and breaker", () => {
  const failing: AiAdapter = {
    key: "openai",
    complete: async () => {
      throw new AdapterError("server", "boom", { status: 503 });
    },
  };
  it("retries once on a transient failure, records the retry and the error, and reports the breaker", async () => {
    await owner`insert into public.ai_privacy_register (org_id, provider_key, lawful_basis, processor_agreement_ref, transfer_mechanism, minimisation_confirmed, recorded_by)
      values (${orgA}, 'openai', 'contract', 'h28a-dpa', 'scc', true, ${userA})`;
    const env = {
      ...testEnv,
      AI_DETERMINISTIC_PROVIDER: undefined,
      AI_OPENAI_API_KEY: "sk-test-not-real",
    };
    const err = await invokeModel(
      args(A(), { deps: deps({ env, adapters: { openai: failing } }) }),
    ).catch((e) => e as GatewayError);
    expect((err as GatewayError).failure).toMatchObject({
      kind: "provider",
      error: "server",
      retryCount: 1,
    });
    const row = (
      await owner`select status, retry_count, error, provider, model from public.ai_interaction where id = ${(err as GatewayError).interactionId!}`
    )[0]!;
    expect(row).toMatchObject({
      status: "failed",
      retry_count: 1,
      provider: "openai",
      model: "openai:gpt-5-nano",
    });
    expect(String(row.error)).toContain("server");
    const state = (
      await owner`select consecutive_failures, health from public.ai_provider_state where provider_key = 'openai'`
    )[0]!;
    expect(Number(state.consecutive_failures)).toBeGreaterThanOrEqual(1);
    expect(["degraded", "down"]).toContain(String(state.health));
    // Four more failures open the breaker; availability then names it and the next call is refused as a breaker decision.
    for (let i = 0; i < 4; i++) {
      await invokeModel(args(A(), { deps: deps({ env, adapters: { openai: failing } }) })).catch(
        () => null,
      );
    }
    const open = (
      await owner`select breaker_open_until from public.ai_provider_state where provider_key = 'openai'`
    )[0]!;
    expect(open.breaker_open_until).not.toBeNull();
    const avail = await aiAvailability(A(), deps({ env }));
    expect(avail.providers.find((p) => p.key === "openai")!.reason).toBe("breaker_open");
    await owner`update public.ai_provider_state set consecutive_failures = 0, breaker_open_until = null, health = 'unknown' where provider_key = 'openai'`;
  });

  it("without a privacy register entry the provider is unavailable to the organisation even with a credential", async () => {
    const env = {
      ...testEnv,
      AI_DETERMINISTIC_PROVIDER: undefined,
      AI_OPENAI_API_KEY: "sk-test-not-real",
    };
    const avail = await aiAvailability(B(), deps({ env }));
    expect(avail.providers.find((p) => p.key === "openai")).toMatchObject({
      configured: true,
      available: false,
      reason: "privacy_register_missing",
    });
  });
});

describe("concurrency, paging and isolation", () => {
  it("ten concurrent calls are all metered once and the ledger equals the usage sum", async () => {
    await setPolicy(orgA, { mode: "trial", monthly_credits: 100000 });
    const before = (
      await owner`select coalesce(sum(credits),0)::int as n from public.ai_interaction where org_id = ${orgA}`
    )[0]!.n as number;
    const results = await Promise.all(Array.from({ length: 10 }, () => invokeModel(args(A()))));
    const sum = results.reduce((n, r) => n + r.credits, 0);
    const after = (
      await owner`select coalesce(sum(credits),0)::int as n from public.ai_interaction where org_id = ${orgA}`
    )[0]!.n as number;
    expect(after - before).toBe(sum);
    const ledger = (
      await owner`select coalesce(-sum(credits),0)::int as n from public.ai_credit_ledger where org_id = ${orgA} and kind = 'consumption'`
    )[0]!.n as number;
    const consumed = (
      await owner`select coalesce(sum(credits),0)::int as n from public.ai_interaction where org_id = ${orgA}`
    )[0]!.n as number;
    expect(ledger).toBe(consumed);
    const meters = (
      await owner`select count(*)::int as n from public.usage_event where org_id = ${orgA} and meter_key = 'ai_credits'`
    )[0]!.n as number;
    const charged = (
      await owner`select count(*)::int as n from public.ai_interaction where org_id = ${orgA} and credits > 0`
    )[0]!.n as number;
    expect(meters).toBe(charged);
  });

  it("usage lists page in the database past 1,000 rows with totals over the full result", async () => {
    await owner`insert into public.ai_interaction (org_id, feature, provider, model, input_tokens, output_tokens, credits, status, created_by, agent_id, budget_decision)
      select ${orgA}, 'agent_run', 'deterministic', 'deterministic:fast', 10, 5, 1, 'ok', ${userA}, 'finance', 'allow'
      from generate_series(1, 1200)`;
    const page = await withCtx(A(), (tx) =>
      listUsage(tx, A(), { agentId: "finance", limit: 200, offset: 0 }),
    );
    expect(page.rows.length).toBe(200);
    expect(page.total).toBe(1200);
    expect(page.totals.credits).toBe(1200);
    const last = await withCtx(A(), (tx) =>
      listUsage(tx, A(), { agentId: "finance", limit: 200, offset: 1100 }),
    );
    expect(last.rows.length).toBe(100);
    const status = await withCtx(A(), async (tx) =>
      allowanceStatus(tx, A(), await resolveAiPolicy(tx, A())),
    );
    expect(status.monthByAgent.finance).toBe(1200);
  });

  it("another organisation sees none of it", async () => {
    const page = await withCtx(B(), (tx) => listUsage(tx, B(), { limit: 50, offset: 0 }));
    expect(page.total).toBe(0);
    const ledger = await withCtx(B(), (tx) =>
      tx.execute(sql`select count(*)::int as n from public.ai_credit_ledger`),
    );
    expect(Number((ledger as unknown as Array<{ n: number }>)[0]!.n)).toBe(0);
  });
});

describe("BYOK", () => {
  it("fails closed without the key-encryption secret, then stores an encrypted key whose ciphertext app_user cannot read", async () => {
    const prev = process.env.AI_BYOK_KEK;
    delete process.env.AI_BYOK_KEK;
    await expect(
      withCtx(A(), (tx) => storeByokKeyIn(tx, A(), "openai", "sk-live-0000000000000000abcd")),
    ).rejects.toThrow(/not provisioned/);
    process.env.AI_BYOK_KEK = Buffer.alloc(32, 7).toString("base64");
    try {
      const saved = await withCtx(A(), (tx) =>
        storeByokKeyIn(tx, A(), "openai", "sk-live-0000000000000000abcd"),
      );
      expect(saved.last4).toBe("abcd");
      const listed = await withCtx(A(), (tx) => listByokKeys(tx, A()));
      expect(listed[0]).toMatchObject({ providerKey: "openai", last4: "abcd" });
      await expect(
        withCtx(A(), (tx) =>
          tx.execute(sql`select key_ciphertext from public.ai_byok_key where id = ${saved.id}`),
        ),
      ).rejects.toThrow(/permission denied|Failed query/);
      const secret = await withCtx(A(), (tx) => activeByokSecretIn(tx, A(), "openai"));
      expect(secret).toBe("sk-live-0000000000000000abcd");
      const stored = (
        await owner`select key_ciphertext from public.ai_byok_key where id = ${saved.id}`
      )[0]!;
      expect(String(stored.key_ciphertext)).not.toContain("sk-live");
      const other = await withCtx(B(), (tx) => activeByokSecretIn(tx, B(), "openai"));
      expect(other).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.AI_BYOK_KEK;
      else process.env.AI_BYOK_KEK = prev;
    }
  });
});
