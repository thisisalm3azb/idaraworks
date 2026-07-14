/**
 * The subscription service (S9). Two sides:
 *
 *  • PLATFORM (no tenant context) — `processSubscriptionWebhook`: verify signature → idempotent
 *    inbox insert → resolve org → run the state machine → `app.advance_subscription` (the DB sole
 *    writer) → tenant-visible audit → mark processed. This is the ONLY thing that changes billing
 *    state (v1 §13: "driven by provider events, never client claims"). It uses a no-context client
 *    so the assert_platform_task-guarded DEFINER functions admit it.
 *
 *  • TENANT (owner context) — `startCheckout` / `cancelSubscription` / `readSubscription`: these
 *    call the provider adapter and READ state; they never write billing state directly. The change
 *    lands via the resulting webhook (with the fake provider, `emitFakeSignal` models that round-trip).
 *
 * Enforcement (FR-9): `assertTenantWritable` blocks ADD/writes in read-only states (suspended /
 * cancelled / purge_pending / purged) — never reads or exports.
 */
import { createAppDb, sql, withCtx, type Ctx } from "@/platform/tenancy";
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import { invalidateEntitlements } from "@/platform/entitlements/resolve";
import {
  getBillingProvider,
  fakeBillingProvider,
  BillingProviderDisabledError,
  type NormalizedEvent,
} from "@/platform/billing/adapter";
import { nextForEvent, type BillingState } from "./machine";
import { computeWindows } from "./windows";
import { logger } from "@/platform/logger";

export { BillingProviderDisabledError };
// Re-export the pure machine/windows surface the lifecycle worker needs, so it imports the
// subscription module ONLY via this service.ts (BUILD_BIBLE §3.3 — no cross-module internal imports).
export { nextForEvent } from "./machine";
export { dueSignal, LIFECYCLE_WINDOWS, type LifecycleRow } from "./windows";

const READ_ONLY_STATES: ReadonlySet<string> = new Set([
  "suspended",
  "cancelled",
  "purge_pending",
  "purged",
]);

/** FR-9: a read-only billing state blocks the ability to ADD, never the ability to see/export. */
export function isReadOnlyBillingState(state: string): boolean {
  return READ_ONLY_STATES.has(state);
}

export class SubscriptionReadOnlyError extends Error {
  constructor(state: string) {
    super(`workspace is read-only (billing state: ${state})`);
    this.name = "SubscriptionReadOnlyError";
  }
}

export class SubscriptionActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionActionError";
  }
}

/** Gate a tenant WRITE/ADD on the org's billing state. Reads must never call this (FR-9). */
export async function assertTenantWritable(ctx: Ctx): Promise<void> {
  const state = await withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select billing_state from public.org_plan_state where org_id = ${ctx.orgId}`)) as unknown as Array<{
      billing_state: string;
    }>;
    return rows[0]?.billing_state ?? "active";
  });
  if (isReadOnlyBillingState(state)) throw new SubscriptionReadOnlyError(state);
}

export type WebhookOutcome = {
  status: "processed" | "duplicate" | "ignored" | "unverified" | "unresolved";
  from?: BillingState;
  to?: BillingState;
};

/**
 * Process one inbound provider webhook. Idempotent + signature-gated + platform-scoped.
 * Returns 200-worthy outcomes for every case (a duplicate/unverified is NOT an error to the caller).
 */
export async function processSubscriptionWebhook(
  rawBody: string,
  signature: string,
): Promise<WebhookOutcome> {
  const provider = getBillingProvider();
  const verified = provider.verifySignature(rawBody, signature);

  const { db, end } = createAppDb({ max: 1 });
  try {
    // An UNVERIFIED event never drives state. We still record it (for audit) if it parses, but only
    // with a resolvable org; otherwise we drop it. Parsing an unverified body is best-effort.
    let evt: NormalizedEvent;
    try {
      evt = provider.parseEvent(rawBody);
    } catch {
      return { status: "unverified" };
    }
    if (!evt.providerEventId || !evt.signal) return { status: "unverified" };

    // Resolve the org from the provider customer id (the reconciliation invariant: one org).
    // Via a DEFINER resolver — org_plan_state is tenant-read-only under RLS, and this platform
    // client has no org context, so a plain SELECT would be RLS-zeroed.
    const orgRows = evt.providerCustomerId
      ? ((await db.execute(sql`
          select org_id::text as org_id, billing_state
          from app.resolve_subscription_org(${provider.id}, ${evt.providerCustomerId})`)) as unknown as Array<{
          org_id: string;
          billing_state: BillingState;
        }>)
      : [];
    const org = orgRows[0];

    // Idempotent inbox insert (first delivery wins). Records unverified rows too, for the trail.
    const rec = (await db.execute(sql`
      select app.record_subscription_event(
        ${provider.id}, ${evt.providerEventId}, ${org?.org_id ?? null}, ${evt.eventType},
        ${JSON.stringify(evt)}::jsonb, ${verified}) as result`)) as unknown as Array<{
      result: string;
    }>;
    if (rec[0]?.result === "duplicate") return { status: "duplicate" };

    if (!verified) return { status: "unverified" };
    if (!org) return { status: "unresolved" };

    // Run the state machine. A no-op signal is recorded as 'ignored' (still idempotent).
    const res = nextForEvent(org.billing_state, evt.signal);
    if (res.to === null) {
      await markProcessed(db, provider.id, evt.providerEventId, "ignored", res.reason);
      return { status: "ignored", from: org.billing_state };
    }

    await applyTransition(db, org.org_id, org.billing_state, res.to, res.reason, Date.now(), {
      planKey: evt.planKey,
      provider: provider.id,
      providerCustomerId: evt.providerCustomerId,
      providerSubscriptionId: evt.providerSubscriptionId,
      billingInterval: evt.billingInterval,
      billingCurrency: evt.billingCurrency,
      eventType: evt.eventType,
    });
    await markProcessed(db, provider.id, evt.providerEventId, "processed", null);
    return { status: "processed", from: org.billing_state, to: res.to };
  } finally {
    await end();
  }
}

type TransitionOpts = {
  planKey?: string | null;
  provider?: string | null;
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
  billingInterval?: string | null;
  billingCurrency?: string | null;
  eventType?: string;
};

/**
 * Persist ONE state transition on a platform client: set the target's lifecycle windows (so the
 * sweep knows the next deadline), call the DB sole-writer `advance_subscription`, write the tenant-
 * visible audit row, and invalidate the same-process entitlement cache. Shared by the webhook
 * processor and the lifecycle sweep. Cross-instance freshness = the resolver's 60s TTL self-heal
 * (serverless-appropriate; a LISTEN/NOTIFY push channel is the documented scaling step).
 */
export async function applyTransition(
  db: ReturnType<typeof createAppDb>["db"],
  orgId: string,
  from: string,
  to: BillingState,
  reason: string,
  nowMs: number,
  opts: TransitionOpts = {},
): Promise<void> {
  const w = computeWindows(to, nowMs);
  await db.execute(sql`
    select app.advance_subscription(
      ${orgId}::uuid, ${to}, ${opts.planKey ?? null}, ${opts.provider ?? null},
      ${opts.providerCustomerId ?? null}, ${opts.providerSubscriptionId ?? null},
      ${opts.billingInterval ?? null}, ${opts.billingCurrency ?? null},
      null, null,
      ${w.trialEnd ?? null}, ${w.graceUntil ?? null}, ${w.suspendAt ?? null}, ${w.purgeAt ?? null},
      null, null)`);
  await db.execute(sql`
    select app.record_platform_audit(
      ${orgId}::uuid, null, ${"subscription." + to}, 'subscription', ${orgId}::uuid,
      ${`subscription ${from} → ${to} (${reason})`},
      ${JSON.stringify({ from, to, event: opts.eventType ?? "lifecycle" })}::jsonb)`);
  invalidateEntitlements(orgId);
  logger.info(
    { orgId, from, to, event: opts.eventType ?? "lifecycle" },
    "subscription state advanced",
  );
}

async function markProcessed(
  db: ReturnType<typeof createAppDb>["db"],
  provider: string,
  eventId: string,
  status: string,
  error: string | null,
): Promise<void> {
  await db.execute(sql`
    select app.mark_subscription_event_processed(${provider}, ${eventId}, ${status}, ${error})`);
}

// ── Tenant (owner) actions ──────────────────────────────────────────────────────────────────────

export type CheckoutRequest = {
  planKey: "starter" | "growth" | "business";
  billingInterval: "month" | "year";
  currency: string;
};

/** Owner starts a checkout. Throws BillingProviderDisabledError when the provider is disabled (D1)
 * — the UI renders "commercial activation unavailable" rather than a live Buy button. */
export async function startCheckout(
  ctx: Ctx,
  archetype: RoleArchetype,
  req: CheckoutRequest,
): Promise<{ url: string }> {
  assertCan(archetype, "billing.manage");
  const provider = getBillingProvider();
  if (!provider.enabled) throw new BillingProviderDisabledError("checkout");
  const r = await provider.createCheckoutSession({
    orgId: ctx.orgId,
    planKey: req.planKey,
    billingInterval: req.billingInterval,
    currency: req.currency,
  });
  return { url: r.url };
}

/** Owner requests cancellation. The provider is told; the state change arrives by webhook. */
export async function cancelSubscription(ctx: Ctx, archetype: RoleArchetype): Promise<void> {
  assertCan(archetype, "billing.manage");
  const provider = getBillingProvider();
  if (!provider.enabled) throw new BillingProviderDisabledError("cancel");
  const sub = await withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select provider_subscription_id from public.org_plan_state where org_id = ${ctx.orgId}`)) as unknown as Array<{
      provider_subscription_id: string | null;
    }>;
    return rows[0]?.provider_subscription_id ?? null;
  });
  if (!sub) throw new SubscriptionActionError("no active provider subscription to cancel");
  await provider.cancelSubscription({ providerSubscriptionId: sub, atPeriodEnd: true });
}

export type SubscriptionView = {
  planKey: string;
  billingState: string;
  readOnly: boolean;
  periodEnd: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  providerEnabled: boolean;
  prices: Array<{
    planKey: string;
    interval: string;
    currency: string;
    unitAmountMinor: number;
    isPlaceholder: boolean;
  }>;
};

/** Read the org's subscription + the (placeholder) price book, for the settings UI. */
export async function readSubscription(
  ctx: Ctx,
  archetype: RoleArchetype,
): Promise<SubscriptionView> {
  assertCan(archetype, "billing.view");
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select plan_key, billing_state, period_end::text as period_end, trial_end::text as trial_end,
             cancel_at_period_end
      from public.org_plan_state where org_id = ${ctx.orgId}`)) as unknown as Array<{
      plan_key: string;
      billing_state: string;
      period_end: string | null;
      trial_end: string | null;
      cancel_at_period_end: boolean;
    }>;
    const s = rows[0]!;
    const prices = (await tx.execute(sql`
      select plan_key, billing_interval, currency, unit_amount_minor::text as amt, is_placeholder
      from public.plan_price where active order by plan_key, billing_interval, currency`)) as unknown as Array<{
      plan_key: string;
      billing_interval: string;
      currency: string;
      amt: string;
      is_placeholder: boolean;
    }>;
    return {
      planKey: s.plan_key,
      billingState: s.billing_state,
      readOnly: isReadOnlyBillingState(s.billing_state),
      periodEnd: s.period_end,
      trialEnd: s.trial_end,
      cancelAtPeriodEnd: s.cancel_at_period_end,
      providerEnabled: getBillingProvider().enabled,
      prices: prices.map((p) => ({
        planKey: p.plan_key,
        interval: p.billing_interval,
        currency: p.currency,
        unitAmountMinor: Number(p.amt),
        isPlaceholder: p.is_placeholder,
      })),
    };
  });
}

/**
 * TEST/DEMO helper (fake provider only): model a "provider → webhook" round-trip by minting a
 * signed event for `signal` and feeding it to the real webhook processor. Never used in prod.
 */
export async function emitFakeSignal(
  orgId: string,
  signal: NormalizedEvent["signal"],
  overrides: Partial<NormalizedEvent> = {},
): Promise<WebhookOutcome> {
  const suffix = overrides.providerEventId ?? `auto_${Date.now()}`;
  const evt: NormalizedEvent = {
    eventType: `fake.${signal}`,
    signal,
    providerCustomerId: `fake_cus_${orgId}`,
    providerSubscriptionId: `fake_sub_${orgId}`,
    planKey: null,
    billingInterval: null,
    billingCurrency: null,
    ...overrides,
    // Compose the id AFTER the spread so it is always org-scoped (the org id is fresh per run, so
    // ids never collide across runs) while the same suffix within a run collapses to a duplicate.
    providerEventId: `fake_${orgId}_${signal}_${suffix}`,
  };
  const { body, signature } = fakeBillingProvider.signEvent(evt);
  return processSubscriptionWebhook(body, signature);
}
