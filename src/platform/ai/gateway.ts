/**
 * H28 — the ONE server-side AI gateway (ADR-50/51/52/54).
 *
 * Every model call in the platform passes through `invokeModel`:
 *   1. size limits on the assembled request,
 *   2. provider availability for THIS organisation (credential, provider and
 *      model state, breaker, privacy register),
 *   3. routing by task class with recorded reasons (no silent assurance downgrade),
 *   4. the ordered budget decision (recorded even when it denies),
 *   5. the adapter call with a hard timeout, cooperative cancellation and one
 *      idempotent retry on transient failure,
 *   6. structured validation of the response shape,
 *   7. metering of the call (success, failure or denial) and the breaker report.
 *
 * Keys are read from the server environment or the organisation's BYOK store
 * inside this file only; nothing here logs or returns them.
 */
import { randomUUID } from "node:crypto";
import { logger } from "@/platform/logger";
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import { anthropicAdapter } from "./adapters/anthropic";
import { deterministicAdapter } from "./adapters/deterministic";
import { disabledAdapter } from "./adapters/disabled";
import { openaiAdapter } from "./adapters/openai";
import {
  AdapterError,
  approxTokens,
  renderBlocks,
  type AiAdapter,
  type FetchLike,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayUsage,
  ZERO_USAGE,
} from "./adapters/types";
import {
  allowanceStatus,
  decideBudget,
  readSwitches,
  resolveAiPolicy,
  type AiPolicy,
  type AllowanceStatus,
  type BudgetReason,
  type BudgetVerdict,
} from "./budget";
import { activeByokSecretIn } from "./byok";
import { recordInteraction, type AiFeature } from "./metering";
import {
  creditsForUsdMicros,
  effectiveCreditPolicy,
  effectivePrice,
  estimateCostMicros,
  estimateUpperBoundMicros,
  type PriceRow,
} from "./pricebook";
import {
  AI_MODELS,
  AI_PROVIDERS,
  TASK_MAY_DOWNGRADE,
  TASK_TIER,
  TIER_RANK,
  type AiModelDef,
  type AiModelKey,
  type AiProviderKey,
  type AiTaskClass,
} from "./registry";

export const MAX_INPUT_TOKENS = 200_000;
export const MAX_OUTPUT_TOKENS = 32_000;
export const DEFAULT_TIMEOUT_MS = 45_000;
export const RETRY_BACKOFF_MS = 800;
const DAILY_SPEND_CAP_MICROS = BigInt(process.env.AI_DAILY_SPEND_CAP_MICROS ?? "100000000000");

const ADAPTERS: Record<AiProviderKey, AiAdapter> = {
  disabled: disabledAdapter,
  deterministic: deterministicAdapter,
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
};

/** Test/dev override: adapters and fetch injected by the harness. */
export type GatewayDeps = {
  adapters?: Partial<Record<AiProviderKey, AiAdapter>>;
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

function envOf(deps: GatewayDeps): Record<string, string | undefined> {
  return deps.env ?? process.env;
}

function isProdEnv(deps: GatewayDeps): boolean {
  return envOf(deps).APP_ENV === "prod";
}

// ── availability ────────────────────────────────────────────────────────────

export type ProviderAvailability = {
  key: AiProviderKey;
  name: string;
  configured: boolean;
  credentialSource: "platform" | "byok" | "none";
  enabled: boolean;
  breakerOpen: boolean;
  privacyRegistered: boolean;
  available: boolean;
  /** Why it is unavailable (first blocking reason), for the owner/customer screens. */
  reason:
    | "ok"
    | "no_credential"
    | "provider_disabled"
    | "breaker_open"
    | "privacy_register_missing"
    | "not_production_safe";
};

type ProviderStateRow = {
  provider_key: string;
  enabled: boolean;
  breaker_open_until: string | null;
};

async function providerStates(tx: TenantTx): Promise<Map<string, ProviderStateRow>> {
  const rows = (await tx.execute(sql`
    select provider_key, enabled, breaker_open_until::text as breaker_open_until from public.ai_provider_state`)) as unknown as ProviderStateRow[];
  return new Map(rows.map((r) => [r.provider_key, r]));
}

async function privacyRegistered(tx: TenantTx, ctx: Ctx): Promise<Set<string>> {
  const rows = (await tx.execute(sql`
    select provider_key from public.ai_privacy_register
    where org_id = ${ctx.orgId} and revoked_at is null and minimisation_confirmed = true`)) as unknown as Array<{
    provider_key: string;
  }>;
  return new Set(rows.map((r) => r.provider_key));
}

async function byokProviders(tx: TenantTx, ctx: Ctx): Promise<Set<string>> {
  const rows = (await tx.execute(sql`
    select distinct provider_key from public.ai_byok_key where org_id = ${ctx.orgId} and revoked_at is null`)) as unknown as Array<{
    provider_key: string;
  }>;
  return new Set(rows.map((r) => r.provider_key));
}

/** Availability of every registered provider for this organisation (no secrets returned). */
export async function providerAvailabilityIn(
  tx: TenantTx,
  ctx: Ctx,
  policy: AiPolicy,
  deps: GatewayDeps = {},
): Promise<ProviderAvailability[]> {
  const env = envOf(deps);
  const states = await providerStates(tx);
  const registered = await privacyRegistered(tx, ctx);
  const byok = policy.mode === "byok" ? await byokProviders(tx, ctx) : new Set<string>();
  const now = (deps.now ?? (() => new Date()))();
  const out: ProviderAvailability[] = [];
  for (const def of Object.values(AI_PROVIDERS)) {
    if (def.kind === "none") continue;
    const state = states.get(def.key);
    const enabled = state ? Boolean(state.enabled) : true;
    const breakerOpen = Boolean(
      state?.breaker_open_until && new Date(state.breaker_open_until) > now,
    );
    let credentialSource: ProviderAvailability["credentialSource"] = "none";
    let configured = false;
    if (def.kind === "test") {
      configured = !isProdEnv(deps) && env.AI_DETERMINISTIC_PROVIDER === "1";
      credentialSource = configured ? "platform" : "none";
    } else if (byok.has(def.key)) {
      configured = true;
      credentialSource = "byok";
    } else if (def.envKey && env[def.envKey]) {
      configured = true;
      credentialSource = "platform";
    }
    const privacyOk = def.kind === "test" ? true : registered.has(def.key);
    let reason: ProviderAvailability["reason"] = "ok";
    if (def.kind === "test" && isProdEnv(deps)) reason = "not_production_safe";
    else if (!configured) reason = "no_credential";
    else if (!enabled) reason = "provider_disabled";
    else if (breakerOpen) reason = "breaker_open";
    else if (!privacyOk) reason = "privacy_register_missing";
    out.push({
      key: def.key,
      name: def.name,
      configured,
      credentialSource,
      enabled,
      breakerOpen,
      privacyRegistered: privacyOk,
      available: reason === "ok",
      reason,
    });
  }
  return out;
}

// ── routing ─────────────────────────────────────────────────────────────────

export type RouteDecision = {
  model: AiModelDef;
  price: PriceRow;
  reason: string;
  requestedTier: AiModelDef["tier"];
  downgraded: boolean;
};

export type RouteFailure =
  | "no_provider_available"
  | "no_model_for_tier"
  | "tier_unavailable_no_downgrade"
  | "model_unpriced"
  | "model_not_allowed";

export class RouteError extends Error {
  readonly code: RouteFailure;
  constructor(code: RouteFailure) {
    super(`routing failed: ${code}`);
    this.code = code;
  }
}

async function modelStates(tx: TenantTx): Promise<Map<string, boolean>> {
  const rows = (await tx.execute(
    sql`select model_key, enabled from public.ai_model_state`,
  )) as unknown as Array<{ model_key: string; enabled: boolean }>;
  return new Map(rows.map((r) => [r.model_key, Boolean(r.enabled)]));
}

/** Choose the cheapest eligible model at the required tier; lower tiers only where the class allows and it is recorded. */
export async function routeIn(
  tx: TenantTx,
  ctx: Ctx,
  policy: AiPolicy,
  taskClass: AiTaskClass,
  opts: { preferStrong?: boolean; requestedModel?: AiModelKey | null; deps?: GatewayDeps } = {},
): Promise<RouteDecision> {
  const deps = opts.deps ?? {};
  const availability = await providerAvailabilityIn(tx, ctx, policy, deps);
  const availableProviders = new Set(availability.filter((a) => a.available).map((a) => a.key));
  if (availableProviders.size === 0) throw new RouteError("no_provider_available");
  const enabledModels = await modelStates(tx);
  const now = (deps.now ?? (() => new Date()))();
  const requestedTier = opts.preferStrong ? "strong" : TASK_TIER[taskClass];

  const eligible = (tier: AiModelDef["tier"]): AiModelDef[] =>
    Object.values(AI_MODELS).filter(
      (m) =>
        m.status === "active" &&
        m.tier === tier &&
        availableProviders.has(m.provider) &&
        (enabledModels.get(m.key) ?? true) &&
        (policy.modelAllow.length === 0 || policy.modelAllow.includes(m.key)),
    );

  if (opts.requestedModel) {
    const m = AI_MODELS[opts.requestedModel];
    if (!m || !availableProviders.has(m.provider) || m.status !== "active")
      throw new RouteError("no_model_for_tier");
    if (policy.modelAllow.length > 0 && !policy.modelAllow.includes(m.key))
      throw new RouteError("model_not_allowed");
    const price = await effectivePrice(tx, m.key, now);
    if (!price) throw new RouteError("model_unpriced");
    return {
      model: m,
      price,
      reason: `requested model ${m.key}`,
      requestedTier,
      downgraded: false,
    };
  }

  // Order: the requested tier; lower tiers only for assurance-neutral classes
  // (recorded as a downgrade); then higher tiers (never less assurance, only cost).
  const tiersToTry: AiModelDef["tier"][] = [requestedTier];
  if (TASK_MAY_DOWNGRADE[taskClass] || opts.preferStrong) {
    for (const t of ["strong", "standard", "small"] as const) {
      if (TIER_RANK[t] < TIER_RANK[requestedTier] && !tiersToTry.includes(t)) tiersToTry.push(t);
    }
  }
  for (const t of ["small", "standard", "strong"] as const) {
    if (TIER_RANK[t] > TIER_RANK[requestedTier] && !tiersToTry.includes(t)) tiersToTry.push(t);
  }
  for (const tier of tiersToTry) {
    const candidates = eligible(tier);
    // Cheapest first: by price row (input + output per MTok), unpriced models are skipped (never inferred).
    const priced: Array<{ m: AiModelDef; p: PriceRow }> = [];
    for (const m of candidates) {
      const p = await effectivePrice(tx, m.key, now);
      if (p) priced.push({ m, p });
    }
    priced.sort((a, b) =>
      Number(
        a.p.inputPerMtokMicros +
          a.p.outputPerMtokMicros -
          (b.p.inputPerMtokMicros + b.p.outputPerMtokMicros),
      ),
    );
    const pick = priced[0];
    if (pick) {
      const downgraded = TIER_RANK[tier] < TIER_RANK[requestedTier];
      const upgraded = TIER_RANK[tier] > TIER_RANK[requestedTier];
      return {
        model: pick.m,
        price: pick.p,
        reason: downgraded
          ? `task ${taskClass} needs ${requestedTier}; ${requestedTier} unavailable, ${tier} allowed for this class`
          : upgraded
            ? `task ${taskClass} needs ${requestedTier}; no eligible ${requestedTier} model, ${tier} used (more assurance, more cost)`
            : `task ${taskClass} → ${tier} tier, cheapest priced eligible model`,
        requestedTier,
        downgraded,
      };
    }
    if (
      candidates.length > 0 &&
      priced.length === 0 &&
      tier === requestedTier &&
      !TASK_MAY_DOWNGRADE[taskClass]
    ) {
      throw new RouteError("model_unpriced");
    }
  }
  throw new RouteError(
    TASK_MAY_DOWNGRADE[taskClass] ? "no_model_for_tier" : "tier_unavailable_no_downgrade",
  );
}

// ── invocation ──────────────────────────────────────────────────────────────

export type InvokeArgs = {
  ctx: Ctx;
  agentId: string;
  agentDomain: string;
  agentEnabled: boolean;
  feature: AiFeature;
  purpose: string;
  taskClass: AiTaskClass;
  request: Omit<GatewayRequest, "correlationId" | "model" | "maxOutputTokens"> & {
    maxOutputTokens?: number;
  };
  conversationId?: string | null;
  runId?: string | null;
  stepNo?: number | null;
  preferStrong?: boolean;
  requestedModel?: AiModelKey | null;
  idempotencyKey?: string;
  signal?: AbortSignal;
  deps?: GatewayDeps;
};

export type InvokeResult = {
  response: GatewayResponse;
  model: AiModelDef;
  route: RouteDecision;
  usage: GatewayUsage;
  credits: number;
  estCostMicros: bigint;
  estCurrency: string;
  interactionId: string;
  retryCount: number;
  latencyMs: number;
  providerRequestId: string | null;
};

export type GatewayFailure =
  | { kind: "denied"; verdict: BudgetVerdict }
  | { kind: "unavailable"; route: RouteFailure }
  | { kind: "too_large" }
  | { kind: "provider"; error: AdapterError["kind"]; message: string; retryCount: number };

export class GatewayError extends Error {
  readonly failure: GatewayFailure;
  readonly interactionId: string | null;
  constructor(failure: GatewayFailure, interactionId: string | null) {
    super(
      failure.kind === "denied"
        ? `AI request refused: ${failure.verdict.reason}`
        : failure.kind === "unavailable"
          ? `no AI provider available: ${failure.route}`
          : failure.kind === "too_large"
            ? "AI request exceeds the size limit"
            : `AI provider failed: ${failure.error}`,
    );
    this.failure = failure;
    this.interactionId = interactionId;
  }
}

async function platformDailySpend(tx: TenantTx): Promise<bigint> {
  const rows = (await tx.execute(
    sql`select app.platform_daily_ai_spend()::text as n`,
  )) as unknown as Array<{ n: string }>;
  return BigInt(rows[0]?.n ?? "0");
}

async function credentialFor(
  tx: TenantTx,
  ctx: Ctx,
  providerKey: AiProviderKey,
  policy: AiPolicy,
  deps: GatewayDeps,
): Promise<string | null> {
  const def = AI_PROVIDERS[providerKey];
  if (def.kind !== "external") return null;
  if (policy.mode === "byok") {
    const k = await activeByokSecretIn(tx, ctx, providerKey);
    if (k) return k;
  }
  return def.envKey ? (envOf(deps)[def.envKey] ?? null) : null;
}

function requestTokens(
  req: Omit<GatewayRequest, "correlationId" | "model" | "maxOutputTokens">,
): number {
  return (
    approxTokens(req.system) +
    approxTokens(renderBlocks(req.blocks)) +
    req.messages.reduce((n, m) => n + approxTokens(m.content), 0) +
    approxTokens(JSON.stringify(req.tools ?? [])) +
    approxTokens(JSON.stringify(req.responseSchema ?? {}))
  );
}

/**
 * The one call site. Never throws a provider-shaped error and never returns
 * fabricated output: a failure is a GatewayError whose row is already metered.
 */
export async function invokeModel(args: InvokeArgs): Promise<InvokeResult> {
  const deps = args.deps ?? {};
  const now = (deps.now ?? (() => new Date()))();
  const ctx = args.ctx;
  const interactionId = randomUUID();
  const maxOutputTokens = Math.min(args.request.maxOutputTokens ?? 4_000, MAX_OUTPUT_TOKENS);
  const inputTokens = requestTokens(args.request);

  // Phase 1 (read facts + decide) in one transaction.
  type Plan = {
    policy: AiPolicy;
    route: RouteDecision;
    verdict: BudgetVerdict;
    allowance: AllowanceStatus;
    estCredits: number;
    credential: string | null;
  };
  // Denials are metered INSIDE the transaction and thrown AFTER it commits:
  // throwing inside withCtx would roll the usage row back.
  const phase1 = await withCtx<Plan | { denial: GatewayError }>(ctx, async (tx) => {
    const policy = await resolveAiPolicy(tx, ctx, now);
    let route: RouteDecision;
    try {
      route = await routeIn(tx, ctx, policy, args.taskClass, {
        preferStrong: args.preferStrong,
        requestedModel: args.requestedModel ?? null,
        deps,
      });
    } catch (e) {
      if (e instanceof RouteError) {
        await recordInteraction(
          tx,
          ctx,
          denialRow(interactionId, args, "disabled", "deny", e.code, null, inputTokens),
        );
        return { denial: new GatewayError({ kind: "unavailable", route: e.code }, interactionId) };
      }
      throw e;
    }
    const creditPolicy = await effectiveCreditPolicy(tx, now);
    const upper = estimateUpperBoundMicros(route.price, inputTokens, maxOutputTokens);
    const estCredits =
      creditPolicy && route.price.currency === "USD" ? creditsForUsdMicros(upper, creditPolicy) : 0;
    const allowance = await allowanceStatus(tx, ctx, policy, now);
    const switches = await readSwitches(
      tx,
      ctx.orgId,
      args.agentId,
      route.model.provider,
      route.model.key,
    );
    const states = await providerStates(tx);
    const st = states.get(route.model.provider);
    const verdict = decideBudget({
      switches,
      providerEnabled: st ? Boolean(st.enabled) : true,
      modelEnabled: true,
      breakerOpen: Boolean(st?.breaker_open_until && new Date(st.breaker_open_until) > now),
      policy,
      agentEnabled: args.agentEnabled,
      agentDomain: args.agentDomain,
      modelKey: route.model.key,
      allowance,
      agentId: args.agentId,
      estimatedCredits: estCredits,
      platformDailySpendMicros: await platformDailySpend(tx),
      platformDailyCapMicros: DAILY_SPEND_CAP_MICROS,
    });
    if (
      verdict.decision === "deny" ||
      verdict.decision === "stopped" ||
      verdict.decision === "breaker"
    ) {
      await recordInteraction(
        tx,
        ctx,
        denialRow(
          interactionId,
          args,
          "disabled",
          verdict.decision,
          verdict.reason,
          route,
          inputTokens,
        ),
      );
      return { denial: new GatewayError({ kind: "denied", verdict }, interactionId) };
    }
    if (
      inputTokens > MAX_INPUT_TOKENS ||
      inputTokens > route.model.contextTokens - maxOutputTokens
    ) {
      await recordInteraction(
        tx,
        ctx,
        denialRow(interactionId, args, "failed", verdict.decision, "too_large", route, inputTokens),
      );
      return { denial: new GatewayError({ kind: "too_large" }, interactionId) };
    }
    const credential = await credentialFor(tx, ctx, route.model.provider, policy, deps);
    return { policy, route, verdict, allowance, estCredits, credential };
  });
  if ("denial" in phase1) throw phase1.denial;
  const plan: Plan = phase1;

  // Phase 2: the call, outside any transaction (never hold a connection while a provider thinks).
  const adapter = deps.adapters?.[plan.route.model.provider] ?? ADAPTERS[plan.route.model.provider];
  const req: GatewayRequest = {
    ...args.request,
    correlationId: interactionId,
    model: plan.route.model,
    maxOutputTokens,
  };
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clientRequestId = (args.idempotencyKey ?? interactionId).slice(0, 120);
  const started = Date.now();
  let response: GatewayResponse | null = null;
  let lastError: AdapterError | null = null;
  let retryCount = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    args.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      response = await adapter.complete(req, {
        signal: ac.signal,
        apiKey: plan.credential,
        fetchImpl: deps.fetchImpl,
        clientRequestId,
      });
      lastError = null;
      break;
    } catch (e) {
      const err =
        e instanceof AdapterError
          ? e
          : ac.signal.aborted
            ? new AdapterError(
                "timeout",
                args.signal?.aborted ? "cancelled" : `timed out after ${timeoutMs}ms`,
              )
            : new AdapterError("server", (e as Error).message ?? "provider error");
      lastError = err;
      if (args.signal?.aborted) break;
      if (!err.retryable || attempt === 1) break;
      retryCount++;
      await sleep(RETRY_BACKOFF_MS);
    } finally {
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onAbort);
    }
  }
  const latencyMs = Date.now() - started;

  // Phase 3: meter + report (failures are metered, committed, then thrown).
  const outcome = await withCtx<InvokeResult | { failure: GatewayError }>(ctx, async (tx) => {
    const providerKey = plan.route.model.provider;
    if (!response) {
      const err = lastError ?? new AdapterError("server", "unknown provider failure");
      if (AI_PROVIDERS[providerKey].kind === "external") {
        await tx.execute(
          sql`select app.ai_provider_report(${providerKey}, false, ${err.message.slice(0, 500)})`,
        );
      }
      await recordInteraction(tx, ctx, {
        ...denialRow(
          interactionId,
          args,
          "failed",
          plan.verdict.decision,
          err.kind,
          plan.route,
          inputTokens,
        ),
        providerRequestId: err.providerRequestId,
        latencyMs,
        retryCount,
        error: `${err.kind}: ${err.message}`,
      });
      return {
        failure: new GatewayError(
          { kind: "provider", error: err.kind, message: err.message, retryCount },
          interactionId,
        ),
      };
    }
    const usage = response.usage;
    const est = estimateCostMicros(plan.route.price, usage);
    const creditPolicy = await effectiveCreditPolicy(tx, now);
    const credits =
      creditPolicy && plan.route.price.currency === "USD"
        ? creditsForUsdMicros(est, creditPolicy)
        : 0;
    if (AI_PROVIDERS[providerKey].kind === "external") {
      await tx.execute(sql`select app.ai_provider_report(${providerKey}, true, null)`);
    }
    await recordInteraction(tx, ctx, {
      id: interactionId,
      feature: args.feature,
      purpose: args.purpose,
      agentId: args.agentId,
      conversationId: args.conversationId ?? null,
      runId: args.runId ?? null,
      stepNo: args.stepNo ?? null,
      provider: providerKey,
      model: plan.route.model.key,
      modelVersion: response.modelVersion,
      usage,
      toolCalls: response.content.filter((c) => c.kind === "tool_call").length,
      providerRequestId: response.providerRequestId,
      latencyMs,
      status: "ok",
      retryCount,
      estCostMicros: est,
      estCurrency: plan.route.price.currency,
      priceBookId: plan.route.price.id,
      credits,
      rateSource: plan.route.price.currency === "USD" ? "usd_native" : "none",
      budgetDecision: plan.verdict.decision,
      error: null,
      extras: {
        route: plan.route.reason,
        requestedTier: plan.route.requestedTier,
        downgraded: plan.route.downgraded,
      },
    });
    logger.info(
      {
        org_id: ctx.orgId,
        agent: args.agentId,
        model: plan.route.model.key,
        credits,
        latency_ms: latencyMs,
        retry: retryCount,
        decision: plan.verdict.decision,
      },
      "ai.gateway.call",
    );
    return {
      response,
      model: plan.route.model,
      route: plan.route,
      usage,
      credits,
      estCostMicros: est,
      estCurrency: plan.route.price.currency,
      interactionId,
      retryCount,
      latencyMs,
      providerRequestId: response.providerRequestId,
    };
  });
  if ("failure" in outcome) throw outcome.failure;
  return outcome;
}

function denialRow(
  id: string,
  args: InvokeArgs,
  status: "failed" | "disabled",
  decision: BudgetVerdict["decision"],
  reason: BudgetReason | RouteFailure | AdapterError["kind"] | "too_large",
  route: RouteDecision | null,
  inputTokens: number,
) {
  return {
    id,
    feature: args.feature,
    purpose: args.purpose,
    agentId: args.agentId,
    conversationId: args.conversationId ?? null,
    runId: args.runId ?? null,
    stepNo: args.stepNo ?? null,
    provider: route?.model.provider ?? "none",
    model: route?.model.key ?? "none",
    modelVersion: null,
    usage: { ...ZERO_USAGE, input: 0 },
    toolCalls: 0,
    providerRequestId: null,
    latencyMs: null,
    status,
    retryCount: 0,
    estCostMicros: null,
    estCurrency: null,
    priceBookId: route?.price.id ?? null,
    credits: 0,
    rateSource: null,
    budgetDecision: decision,
    error: reason,
    extras: { approxInputTokens: inputTokens },
  };
}

/** Read-only availability summary for settings and the dock (no secrets). */
export async function aiAvailability(
  ctx: Ctx,
  deps: GatewayDeps = {},
): Promise<{
  policy: AiPolicy;
  providers: ProviderAvailability[];
  anyAvailable: boolean;
  allowance: AllowanceStatus;
  switches: { globalStop: boolean; orgStop: boolean };
}> {
  return withCtx(ctx, async (tx) => {
    const policy = await resolveAiPolicy(tx, ctx);
    const providers = await providerAvailabilityIn(tx, ctx, policy, deps);
    const allowance = await allowanceStatus(tx, ctx, policy);
    const sw = await readSwitches(tx, ctx.orgId, "", "", "");
    return {
      policy,
      providers,
      anyAvailable: providers.some((p) => p.available),
      allowance,
      switches: { globalStop: sw.globalStop, orgStop: sw.orgStop },
    };
  });
}
