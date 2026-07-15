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
import { randomUUID } from "node:crypto";
import { createAppDb, sql, withCtx, type Ctx } from "@/platform/tenancy";
import { assertCan, can } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import {
  invalidateEntitlements,
  isReadOnlyBillingState,
  BillingReadOnlyError,
} from "@/platform/entitlements/resolve";
import {
  getBillingProvider,
  fakeBillingProvider,
  BillingProviderDisabledError,
  type NormalizedEvent,
  type AddonChangePayload,
} from "@/platform/billing/adapter";
import {
  ADDONS,
  BUNDLES,
  getAddon,
  getBundle,
  isPurchasable,
  type AddonAvailability,
} from "@/platform/entitlements/addons";
import { nextForEvent, type BillingState } from "./machine";
import { computeWindows, monthlyPeriodEnd } from "./windows";
import { logger } from "@/platform/logger";

export { BillingProviderDisabledError };
// Re-export the pure machine/windows surface the lifecycle worker needs, so it imports the
// subscription module ONLY via this service.ts (BUILD_BIBLE §3.3 — no cross-module internal imports).
export { nextForEvent } from "./machine";
export { dueSignal, LIFECYCLE_WINDOWS, monthlyPeriodEnd, type LifecycleRow } from "./windows";
// The read-only concept + error live in the platform entitlement layer (the command() chokepoint
// enforces FR-9 there). Re-export the error under the S9 name for callers/tests.
export { isReadOnlyBillingState } from "@/platform/entitlements/resolve";
export { BillingReadOnlyError as SubscriptionReadOnlyError } from "@/platform/entitlements/resolve";
// U3 selection surface (pure view assembly) — re-exported here because service.ts is the module's
// only public surface (BUILD_BIBLE §3.2): app pages + the wave-2 onboarding flow import from here.
export {
  buildSelectionView,
  computeMonthlyTotalMinor,
  currentSelectionLabel,
  type SelectionView,
  type SelectionTier,
  type SelectionCurrency,
  type SelectionCustomGroup,
  type OrgAddonStateRow,
} from "./selection";

export class SubscriptionActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionActionError";
  }
}

/** A purchase was attempted for an add-on that is not purchasable (HONESTY LAW: only
 * available/manual_process items ever sell; the availability class says why this one doesn't). */
export class AddonUnavailableError extends Error {
  constructor(
    public readonly addonKey: string,
    public readonly availability: AddonAvailability,
  ) {
    super(`add-on ${addonKey} is not purchasable (${availability})`);
    this.name = "AddonUnavailableError";
  }
}

/**
 * PART C — the subscription-change error taxonomy. Every governed change maps any
 * failure onto ONE of these codes so the surface can show a safe, actionable
 * message (never a DB/provider internal) alongside a correlation id, while the
 * real error is logged server-side under that same id. The i18n danger banner
 * renders `subscription.error.<code>`.
 */
export type SubscriptionErrorCode =
  | "authorization" // the actor lacks billing.manage
  | "read_only" // the org is in a read-only billing state (suspended/cancelled/…)
  | "invalid_quantity" // a pack quantity outside 1..99
  | "unavailable_addon" // an add-on that is not purchasable (manual/other)
  | "credential_gated" // needs a provider credential first
  | "d1_gated" // needs the real-payment decision D1
  | "deferred" // capability does not exist yet — never purchasable
  | "unknown_addon" // an add-on/bundle key not in the catalogue
  | "not_active" // remove/decrease of an add-on the org does not hold
  | "stale_price_version" // the catalogue prices moved under the review
  | "concurrent_change" // the org's add-on state changed under the request
  | "invalid_transition" // an illegal lifecycle move (e.g. cancel a purged org)
  | "provider_unavailable" // the REAL payment provider is off (D1) on a real-charge path
  | "network_retry" // a transient DB/provider hiccup — safe to retry
  | "internal"; // anything else — retained, logged, never leaked

/** A governed subscription change failed with a classified, safe-to-show code.
 * Carries the correlation id linking the tenant message to the server log. */
export class SubscriptionChangeError extends Error {
  constructor(
    public readonly code: SubscriptionErrorCode,
    public readonly correlationId: string,
    message: string,
  ) {
    super(message);
    this.name = "SubscriptionChangeError";
  }
}

/** A short, non-guessable correlation id (surfaced to the tenant, logged server-side). */
export function newCorrelationId(): string {
  return "sub_" + randomUUID().slice(0, 8);
}

/**
 * Map ANY thrown error onto a { code, correlationId } the surface can render.
 * The correlation id is minted here (or reused from an already-classified error),
 * and the real error is logged under it — so the banner stays generic while the
 * operator can find the exact failure. Never leaks DB/provider internals.
 */
export function classifySubscriptionError(
  err: unknown,
  correlationId = newCorrelationId(),
): { code: SubscriptionErrorCode; correlationId: string } {
  if (err instanceof SubscriptionChangeError) {
    return { code: err.code, correlationId: err.correlationId };
  }
  if (err instanceof AddonUnavailableError) {
    const map: Record<AddonAvailability, SubscriptionErrorCode> = {
      available: "unavailable_addon",
      manual_process: "unavailable_addon",
      credential_gated: "credential_gated",
      d1_gated: "d1_gated",
      deferred: "deferred",
    };
    return { code: map[err.availability], correlationId };
  }
  if (err instanceof BillingReadOnlyError) return { code: "read_only", correlationId };
  if (err instanceof BillingProviderDisabledError) {
    return { code: "provider_unavailable", correlationId };
  }
  // ForbiddenError from authz (name-checked to avoid importing the class for an instanceof).
  if (err instanceof Error && err.name === "ForbiddenError") {
    return { code: "authorization", correlationId };
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/deadlock|could not serialize|connection|timeout|ETIMEDOUT|ECONNRESET/i.test(msg)) {
    return { code: "network_retry", correlationId };
  }
  return { code: "internal", correlationId };
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
  if (isReadOnlyBillingState(state)) throw new BillingReadOnlyError(state);
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

    // A plan change is NOT a state transition (v1 §13): upgrade applies immediately, downgrade is
    // scheduled to period end. Handle it before the state machine and keep billing_state unchanged.
    if (evt.signal === "plan_changed" && evt.planKey) {
      await applyPlanChange(
        db,
        org.org_id,
        org.billing_state,
        evt.planKey,
        evt.planChangeMode ?? "immediate",
      );
      await markProcessed(db, provider.id, evt.providerEventId, "processed", null);
      return { status: "processed", from: org.billing_state, to: org.billing_state };
    }

    // An add-on change is NOT a state transition either: apply the org_addon upsert (via the
    // set_org_addon sole writer) and keep billing_state unchanged. A malformed/unknown payload is
    // recorded on the inbox row — never a thrown 500 (the provider must not retry it into a storm).
    if (evt.signal === "addon_changed") {
      if (!evt.addonChange) {
        await markProcessed(db, provider.id, evt.providerEventId, "ignored", "no addon payload");
        return { status: "ignored", from: org.billing_state };
      }
      const res = await applyAddonChange(db, org.org_id, evt.addonChange, evt.providerEventId);
      if (!res.ok) {
        await markProcessed(db, provider.id, evt.providerEventId, "failed", res.error);
        return { status: "ignored", from: org.billing_state };
      }
      await markProcessed(db, provider.id, evt.providerEventId, "processed", null);
      return { status: "processed", from: org.billing_state, to: org.billing_state };
    }

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
  /**
   * Audit provenance (U3 governed-change model): who/what drove this write.
   * 'provider_event' (default) for the webhook path and lifecycle sweep;
   * 'owner_action' for the governed self-service test/trial path; the audit
   * history section derives the tenant-visible source from this marker. It NEVER
   * changes what is written — only how the change is attributed. */
  via?: AuditProvenance;
};

/** Audit provenance of a subscription change (surfaced tenant-visibly). */
export type AuditProvenance =
  | "onboarding" // recorded at the onboarding plan step (no entitlements)
  | "owner_action" // the governed self-service change (owner, server-authorized, no real charge)
  | "provider_event" // a verified provider webhook / the lifecycle sweep — the sole writer of PAID activation
  | "platform_override"; // a platform admin acted on the org

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
      ${JSON.stringify({ from, to, event: opts.eventType ?? "lifecycle", via: opts.via ?? "provider_event" })}::jsonb)`);
  invalidateEntitlements(orgId);
  logger.info(
    { orgId, from, to, event: opts.eventType ?? "lifecycle" },
    "subscription state advanced",
  );
}

/**
 * Apply a plan change WITHOUT moving billing_state. Upgrade ('immediate') sets plan_key now and
 * clears any scheduled downgrade; downgrade ('scheduled') records scheduled_plan_key (applied at
 * period end by a later immediate plan_changed event OR the lifecycle sweep's scheduled-plan step,
 * which calls the 'immediate' mode here). Never deletes data — an org that exceeds the new plan's
 * limits simply loses the ability to ADD (checkLimit), never to read (FR-9). Platform-path only
 * (webhook processor / lifecycle worker) — exported for the worker, never for a tenant action.
 */
export async function applyPlanChange(
  db: ReturnType<typeof createAppDb>["db"],
  orgId: string,
  state: string,
  newPlanKey: string,
  mode: "immediate" | "scheduled",
): Promise<void> {
  if (mode === "scheduled") {
    // Downgrade intent: state + plan unchanged; record the scheduled plan.
    await db.execute(sql`
      select app.advance_subscription(${orgId}::uuid, ${state}, null, null, null, null, null, null,
        null, null, null, null, null, null, null, ${newPlanKey})`);
    await db.execute(sql`
      select app.record_platform_audit(${orgId}::uuid, null, 'subscription.downgrade_scheduled',
        'subscription', ${orgId}::uuid, ${`Downgrade to ${newPlanKey} scheduled for period end`},
        ${JSON.stringify({ scheduledPlan: newPlanKey })}::jsonb)`);
  } else {
    // Immediate (upgrade / period-end application): set plan_key now, clear the scheduled marker ('').
    await db.execute(sql`
      select app.advance_subscription(${orgId}::uuid, ${state}, ${newPlanKey}, null, null, null, null,
        null, null, null, null, null, null, null, null, '')`);
    await db.execute(sql`
      select app.record_platform_audit(${orgId}::uuid, null, 'subscription.plan_changed',
        'subscription', ${orgId}::uuid, ${`Plan changed to ${newPlanKey}`},
        ${JSON.stringify({ plan: newPlanKey })}::jsonb)`);
  }
  invalidateEntitlements(orgId);
}

/**
 * Apply ONE add-on change on a platform client (the webhook path — provider events remain the sole
 * writer of org_addon; changeAddons below never writes it directly). Validates the key against the
 * code catalogue, upserts via the DEFINER sole writer `set_org_addon`, writes the tenant-visible
 * audit row (same style as applyPlanChange), and invalidates the entitlement cache. Any refusal
 * (unknown key, or the DB wall rejecting e.g. a deferred add-on) is RETURNED, never thrown — the
 * webhook processor records it on the inbox row instead of 500ing the provider into retries.
 */
export async function applyAddonChange(
  db: ReturnType<typeof createAppDb>["db"],
  orgId: string,
  payload: AddonChangePayload,
  eventRef: string,
  via: AuditProvenance = "provider_event",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const def = getAddon(payload.addon_key);
  if (!def) {
    return { ok: false, error: `unknown addon key ${payload.addon_key}` };
  }
  // HONESTY LAW at the webhook wall too (the DB wall blocks only 'deferred'): an ACTIVATION of a
  // non-purchasable add-on is refused even on a correctly-signed provider event. Flipping an
  // already-granted non-purchasable key to removal_scheduled/removed must STILL pass — ops-granted
  // gated add-ons are removed through this same path.
  if (payload.status === "active" && !isPurchasable(def)) {
    return {
      ok: false,
      error: `addon ${payload.addon_key} is not purchasable (${def.availability})`,
    };
  }
  try {
    await db.execute(sql`
      select app.set_org_addon(${orgId}::uuid, ${payload.addon_key}, ${payload.quantity},
        ${payload.status}, ${payload.remove_at}, ${payload.source})`);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  await db.execute(sql`
    select app.record_platform_audit(${orgId}::uuid, null, 'subscription.addons_changed',
      'subscription', ${orgId}::uuid,
      ${`Add-on ${payload.addon_key} → ${payload.status} (×${payload.quantity})`},
      ${JSON.stringify({
        addon: payload.addon_key,
        quantity: payload.quantity,
        status: payload.status,
        source: payload.source,
        event: eventRef,
        via,
        // A governed owner_action write is an explicit trial/test change pre-D1:
        // it grants a real entitlement but collects NO payment (honesty law #5).
        trial: via === "owner_action" ? true : undefined,
        remove_at: payload.remove_at,
      })}::jsonb)`);
  invalidateEntitlements(orgId);
  return { ok: true };
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

/**
 * Owner changes plan. Upgrade (a higher-sorted plan) applies immediately; downgrade is scheduled to
 * period end (never deletes data). The change is driven through the provider→webhook round-trip
 * (with the fake provider, modelled by emitFakeSignal). Returns the resolved mode.
 */
export async function changePlan(
  ctx: Ctx,
  archetype: RoleArchetype,
  newPlanKey: "starter" | "growth" | "business",
): Promise<{ mode: "immediate" | "scheduled" }> {
  assertCan(archetype, "billing.manage");
  const provider = getBillingProvider();
  if (!provider.enabled) throw new BillingProviderDisabledError("changePlan");
  const sort = await withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select (select sort_order from public.plan where key = ops.plan_key) as cur,
             (select sort_order from public.plan where key = ${newPlanKey}) as nxt,
             ops.plan_key as current_plan
      from public.org_plan_state ops where ops.org_id = ${ctx.orgId}`)) as unknown as Array<{
      cur: number;
      nxt: number;
      current_plan: string;
    }>;
    return rows[0]!;
  });
  if (sort.current_plan === newPlanKey) throw new SubscriptionActionError("already on that plan");
  const mode: "immediate" | "scheduled" = sort.nxt > sort.cur ? "immediate" : "scheduled";
  // Fake provider (dev/test): model provider → webhook. A real provider is told via its API and
  // emits the webhook that this same processor applies (no different code path at activation).
  // The linkage is established first (org creation never sets provider_customer_id) and the
  // outcome is CHECKED — a discarded 'unresolved' used to report every failure as success.
  await ensureFakeProviderLinkage(ctx);
  const out = await emitFakeSignal(ctx.orgId, "plan_changed", {
    planKey: newPlanKey,
    planChangeMode: mode,
  });
  assertWebhookApplied(out, `plan ${newPlanKey}`);
  return { mode };
}

export type AddonChangeRequest = {
  additions: Array<{ addonKey: string; quantity?: number }>;
  removals: string[];
  /** Expands to its member add-ons, each tagged source 'bundle.<key>' (the SAME addon keys —
   * a bundle is a discounted collection, never a second entitlement system). */
  bundleKey?: string;
  /** Schedules period-end removal of EVERY org_addon row sourced from this bundle
   * (source = 'bundle.<key>') — the bundle-level counterpart of `removals`. */
  removeBundleKey?: string;
};

/** Purchase quantities are bounded 1..99 (packs are small integers; anything else is a bug or an
 * abuse attempt — refused, never silently clamped). */
const MAX_ADDON_QUANTITY = 99;

export type AddonChangeResult = {
  added: number;
  removalScheduled: number;
  /** The period-end deadline scheduled removals apply at (null when nothing was removed). */
  removeAt: string | null;
};

type CurrentAddonRow = { addon_key: string; quantity: number; status: string; source: string };

/** The org's CURRENT add-on rows + the deterministic no-provider period anchor. One tenant read
 * (org_addon is tenant-read-only). Shared by the fake-round-trip path and the governed path. */
async function readCurrentAddonState(
  ctx: Ctx,
): Promise<{ anchor: string | null; rows: CurrentAddonRow[] }> {
  return withCtx(ctx, async (tx) => {
    const plan = (await tx.execute(sql`
      select period_start::text as period_start from public.org_plan_state
      where org_id = ${ctx.orgId}`)) as unknown as Array<{ period_start: string }>;
    const addons = (await tx.execute(sql`
      select addon_key, quantity, status, source from public.org_addon
      where org_id = ${ctx.orgId} and status in ('active','removal_scheduled')`)) as unknown as CurrentAddonRow[];
    return { anchor: plan[0]?.period_start ?? null, rows: addons };
  });
}

export type PlannedAddonChange = {
  /** Additions/upserts to apply immediately, deduped by key (bundle members tagged with source). */
  byKey: Map<string, { quantity: number; source: string }>;
  /** Removals scheduled to period end (never deletes data). */
  removals: Array<{ addonKey: string; quantity: number; source: string }>;
  /** The period-end deadline the removals apply at (null when nothing is removed). */
  removeAt: string | null;
};

/**
 * PURE planner: validate a change request against the org's CURRENT rows and compute the exact
 * additions + scheduled removals. The SINGLE source of the change laws — honesty (only purchasable
 * add-ons sell), quantity bounds (1..99; non-stackable pinned to 1), the decrease-is-period-end
 * refusal, and bundle-removal expansion. Both the fake-provider round-trip (`changeAddons`) and the
 * governed self-service path (`applyGovernedAddonChange`) call it, so they can NEVER diverge. Throws
 * the SAME typed errors both surfaces already map (SubscriptionActionError / AddonUnavailableError).
 */
export function planAddonChange(
  req: AddonChangeRequest,
  rows: readonly CurrentAddonRow[],
  anchor: string | null,
): PlannedAddonChange {
  // Expand the bundle, then dedupe by key (last wins) so one request emits one signal per add-on.
  // Quantity law: bounds-checked 1..MAX_ADDON_QUANTITY; a non-stackable add-on is ALWAYS quantity 1.
  const byKey = new Map<string, { quantity: number; source: string }>();
  for (const a of req.additions) {
    const def = getAddon(a.addonKey);
    if (!def) throw new SubscriptionActionError(`unknown add-on ${a.addonKey}`);
    const requested = Math.trunc(a.quantity ?? 1);
    if (!Number.isFinite(requested) || requested < 1 || requested > MAX_ADDON_QUANTITY) {
      throw new SubscriptionActionError(
        `quantity for ${a.addonKey} must be between 1 and ${MAX_ADDON_QUANTITY}`,
      );
    }
    byKey.set(a.addonKey, { quantity: def.stackable ? requested : 1, source: "individual" });
  }
  if (req.bundleKey) {
    const bundle = getBundle(req.bundleKey);
    if (!bundle) throw new SubscriptionActionError(`unknown bundle ${req.bundleKey}`);
    for (const key of bundle.addonKeys) byKey.set(key, { quantity: 1, source: bundle.key });
  }
  // HONESTY LAW: only available/manual_process add-ons are purchasable — a deferred/
  // credential_gated/d1_gated addition is refused with its availability class.
  for (const [key] of byKey) {
    const def = getAddon(key);
    if (!def) throw new SubscriptionActionError(`unknown add-on ${key}`);
    if (!isPurchasable(def)) throw new AddonUnavailableError(def.key, def.availability);
  }
  if (req.removeBundleKey && !getBundle(req.removeBundleKey)) {
    throw new SubscriptionActionError(`unknown bundle ${req.removeBundleKey}`);
  }

  // Quantity-decrease law: a LOWER quantity than currently held is a period-end change, exactly like
  // a removal (the org paid for the larger pack through the period) — never applies immediately.
  for (const [key, a] of byKey) {
    const cur = rows.find((r) => r.addon_key === key && r.status === "active");
    if (cur && a.quantity < Number(cur.quantity)) {
      throw new SubscriptionActionError(
        `add-on ${key} is active at quantity ${cur.quantity}; a decrease applies at period end — ` +
          `remove the pack and re-add it at the lower quantity next period`,
      );
    }
  }

  // Removals: explicit keys + (removeBundleKey) every current row sourced from that bundle.
  let removeAt: string | null = null;
  const removals: Array<{ addonKey: string; quantity: number; source: string }> = [];
  const removalKeys = [...req.removals];
  if (req.removeBundleKey) {
    for (const r of rows) {
      if (r.source === req.removeBundleKey && !removalKeys.includes(r.addon_key)) {
        removalKeys.push(r.addon_key);
      }
    }
    if (removalKeys.length === req.removals.length) {
      throw new SubscriptionActionError(`bundle ${req.removeBundleKey} is not active`);
    }
  }
  if (removalKeys.length > 0) {
    removeAt = monthlyPeriodEnd(anchor ? new Date(anchor) : new Date(), new Date());
    for (const key of removalKeys) {
      if (!getAddon(key)) throw new SubscriptionActionError(`unknown add-on ${key}`);
      const cur = rows.find((r) => r.addon_key === key);
      if (!cur) throw new SubscriptionActionError(`add-on ${key} is not active`);
      removals.push({ addonKey: key, quantity: cur.quantity, source: cur.source });
    }
  }
  return { byKey, removals, removeAt };
}

/**
 * Owner changes add-ons. Additions apply immediately; removals are scheduled to PERIOD END (the org
 * paid through the period — never mid-cycle, never deletes data). Everything is driven through the
 * provider→webhook round-trip (with the fake provider, modelled by emitFakeSignal — one
 * addon_changed signal per add-on), so provider events remain the SOLE writer of org_addon.
 */
export async function changeAddons(
  ctx: Ctx,
  archetype: RoleArchetype,
  req: AddonChangeRequest,
): Promise<AddonChangeResult> {
  assertCan(archetype, "billing.manage");
  const provider = getBillingProvider();
  if (!provider.enabled) throw new BillingProviderDisabledError("changeAddons");

  const state = await readCurrentAddonState(ctx);
  const { byKey, removals, removeAt } = planAddonChange(req, state.rows, state.anchor);

  // Fake provider (dev/test): establish the org↔provider linkage (org creation never sets
  // provider_customer_id — without this EVERY normally-created org round-tripped to 'unresolved'),
  // then model provider → webhook, one addon_changed event per add-on, CHECKING each outcome.
  // A real provider is told via its API and emits the webhooks this same processor applies.
  // org_addon is NEVER written here — applyAddonChange (the webhook path) is the only writer.
  await ensureFakeProviderLinkage(ctx);
  for (const [key, a] of byKey) {
    const out = await emitFakeSignal(ctx.orgId, "addon_changed", {
      providerEventId: `${key}_${Date.now()}`, // per-add-on suffix — never collapses as a duplicate
      addonChange: {
        addon_key: key,
        quantity: a.quantity,
        status: "active",
        remove_at: null,
        source: a.source,
      },
    });
    assertWebhookApplied(out, `add-on ${key}`);
  }
  for (const r of removals) {
    const out = await emitFakeSignal(ctx.orgId, "addon_changed", {
      providerEventId: `${r.addonKey}_${Date.now()}`,
      addonChange: {
        addon_key: r.addonKey,
        quantity: r.quantity,
        status: "removal_scheduled",
        remove_at: removeAt,
        source: r.source,
      },
    });
    assertWebhookApplied(out, `add-on ${r.addonKey}`);
  }
  return { added: byKey.size, removalScheduled: removals.length, removeAt };
}

/**
 * A tenant-initiated change is only a success when the modelled webhook actually APPLIED:
 * 'processed', or 'duplicate' (an idempotent replay of the same signal). Anything else —
 * 'unresolved' (org↔provider linkage missing), 'unverified', 'ignored'/'failed' (the wall refused
 * the payload) — must surface as a thrown error the action maps to the danger banner. The old code
 * discarded the outcome, so every failure (including 'unresolved' for ALL normally-created orgs)
 * was reported as success.
 */
function assertWebhookApplied(out: WebhookOutcome, what: string): void {
  if (out.status === "processed" || out.status === "duplicate") return;
  throw new SubscriptionActionError(
    `change for ${what} was not applied (webhook outcome: ${out.status})`,
  );
}

/**
 * FAKE-PROVIDER ONLY: guarantee the org↔provider linkage the webhook resolver needs. Root cause
 * of the 'unresolved' failure: org creation (app.create_org_with_owner) never sets
 * provider_customer_id, so the modelled round-trip resolved NO org for every app-created org.
 * Fix inside the fake path: persist the deterministic fake ids via the EXISTING DB sole writer
 * `app.advance_subscription` (0053 — "a no-op (same state, same plan) still safely refreshes the
 * linkage"; provider ids passed to it are persisted) on a no-context platform client. No new
 * migration or writer function needed. Never runs in prod: getBillingProvider() resolves the
 * DISABLED provider there (identity check below), and both callers throw
 * BillingProviderDisabledError before reaching this. An EXISTING linkage is never overwritten —
 * a broken/foreign linkage stays broken and surfaces as 'unresolved' via assertWebhookApplied.
 */
async function ensureFakeProviderLinkage(ctx: Ctx): Promise<void> {
  if (getBillingProvider() !== fakeBillingProvider) return;
  const row = await withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select billing_state, provider_customer_id from public.org_plan_state
      where org_id = ${ctx.orgId}`)) as unknown as Array<{
      billing_state: string;
      provider_customer_id: string | null;
    }>;
    return rows[0];
  });
  if (!row) throw new SubscriptionActionError("org has no plan state");
  if (row.provider_customer_id) return;
  const { db, end } = createAppDb({ max: 1 });
  try {
    await db.execute(sql`
      select app.advance_subscription(${ctx.orgId}::uuid, ${row.billing_state}, null, 'fake',
        ${`fake_cus_${ctx.orgId}`}, ${`fake_sub_${ctx.orgId}`})`);
  } finally {
    await end();
  }
}

// ── PART B: the GOVERNED self-service test/trial path ───────────────────────────────────────────
// The settings subscription page must be a real management surface EVEN when the real payment
// provider is disabled (prod, D1). The governed path is what powers it: an owner-authorized,
// server-side, audited change that applies through the SAME lifecycle writers as the provider webhook
// (app.set_org_addon / app.advance_subscription via applyAddonChange / applyTransition) but WITHOUT a
// real charge and labelled a trial/test change (audit `via='owner_action'`, `trial=true`).
//
// Why this does not violate "provider events are the sole writer of billing state / PAID activation":
//  • It grants a real entitlement for the trial/pilot — no money is collected, and nothing here ever
//    CLAIMS money moved. Real PAID activation (a charge) still only lands through a verified provider
//    event, which stays the sole writer of that.
//  • It is SERVER-authorized (assertCan billing.manage on the resolved session) and audited. A forged
//    client request cannot reach the DEFINER writers — they run on a no-context platform client that
//    only this owner-gated service function opens. So a client claim can never activate entitlements.

/** The catalogue price fingerprint (U3): a stale-price guard. The review carries this; the governed
 * apply refuses if the catalogue prices moved under the review (SubscriptionChangeError). Cheap +
 * deterministic — the sum of every purchasable add-on's USD+AED price, which changes iff any price
 * changes. */
export function currentPriceVersion(): string {
  let acc = 0;
  for (const a of ADDONS)
    acc = (acc * 31 + a.usdMonthlyMinor * 7 + a.aedMonthlyMinor) % 1_000_000_007;
  for (const b of BUNDLES)
    acc = (acc * 31 + b.usdMonthlyMinor * 7 + b.aedMonthlyMinor) % 1_000_000_007;
  return "pv_" + acc.toString(36);
}

export type GovernedChangeOptions = {
  /** The price fingerprint the review was computed against — refused if it has moved (stale). */
  priceVersion?: string;
  /** A correlation id to thread through the audit + logs (minted if absent). */
  correlationId?: string;
};

/**
 * Apply an add-on change through the governed test/trial path. Same validation + laws as
 * `changeAddons` (via the shared `planAddonChange`), but the write goes DIRECTLY through the
 * webhook-path applier on a platform client — no provider round-trip, no `provider.enabled` gate —
 * attributed `via='owner_action'`. Additions immediate; removals scheduled to period end. Idempotent
 * (set_org_addon is an upsert keyed on (org_id, addon_key)); duplicate confirms converge.
 */
export async function applyGovernedAddonChange(
  ctx: Ctx,
  archetype: RoleArchetype,
  req: AddonChangeRequest,
  opts: GovernedChangeOptions = {},
): Promise<AddonChangeResult> {
  const correlationId = opts.correlationId ?? newCorrelationId();
  // AUTHORIZATION (server-side, the sole gate): owner only (billing.manage). Never client-trusted.
  if (!can(archetype, "billing.manage")) {
    throw new SubscriptionChangeError("authorization", correlationId, "billing.manage required");
  }
  // Read-only billing states block every ADD/change (FR-9) — a suspended org is view-only.
  await assertTenantWritableGoverned(ctx, correlationId);
  // Stale-price guard: the catalogue must not have moved under the review the owner confirmed.
  if (opts.priceVersion && opts.priceVersion !== currentPriceVersion()) {
    throw new SubscriptionChangeError(
      "stale_price_version",
      correlationId,
      "catalogue prices changed since the review",
    );
  }

  const state = await readCurrentAddonState(ctx);
  let plan: PlannedAddonChange;
  try {
    plan = planAddonChange(req, state.rows, state.anchor);
  } catch (err) {
    // Re-raise as a classified governed error so the surface shows a safe message + this id.
    const { code } = classifySubscriptionError(err, correlationId);
    throw new SubscriptionChangeError(code, correlationId, (err as Error).message);
  }

  // Apply through the SAME sole writer the webhook path uses, on a no-context platform client,
  // attributed owner_action. A refusal from the DB wall is classified, never leaked.
  const { db, end } = createAppDb({ max: 1 });
  try {
    for (const [key, a] of plan.byKey) {
      const res = await applyAddonChange(
        db,
        ctx.orgId,
        {
          addon_key: key,
          quantity: a.quantity,
          status: "active",
          remove_at: null,
          source: a.source,
        },
        `${correlationId}_${key}`,
        "owner_action",
      );
      if (!res.ok) throw governedApplierError(res.error, correlationId);
    }
    for (const r of plan.removals) {
      const res = await applyAddonChange(
        db,
        ctx.orgId,
        {
          addon_key: r.addonKey,
          quantity: r.quantity,
          status: "removal_scheduled",
          remove_at: plan.removeAt,
          source: r.source,
        },
        `${correlationId}_${r.addonKey}`,
        "owner_action",
      );
      if (!res.ok) throw governedApplierError(res.error, correlationId);
    }
  } finally {
    await end();
  }
  logger.info(
    { orgId: ctx.orgId, correlationId, added: plan.byKey.size, removed: plan.removals.length },
    "governed subscription change applied (owner_action, no charge)",
  );
  return {
    added: plan.byKey.size,
    removalScheduled: plan.removals.length,
    removeAt: plan.removeAt,
  };
}

/**
 * Governed "make the individual add-on set equal `desired`" (the settings Manage-add-ons builder).
 * Additions = every desired key; removals = every currently-individual active key absent from
 * desired (scheduled to period end — never deletes data). Bundle-sourced rows are left untouched
 * (the builder marks them included; they are managed via the bundle controls). Delegates to
 * applyGovernedAddonChange so the laws, authorization, price guard and audit all run once.
 */
export async function applyGovernedAddonSet(
  ctx: Ctx,
  archetype: RoleArchetype,
  desired: Record<string, number>,
  opts: GovernedChangeOptions = {},
): Promise<AddonChangeResult> {
  const correlationId = opts.correlationId ?? newCorrelationId();
  if (!can(archetype, "billing.manage")) {
    throw new SubscriptionChangeError("authorization", correlationId, "billing.manage required");
  }
  const state = await readCurrentAddonState(ctx);
  const currentIndividual = state.rows.filter(
    (r) => r.source === "individual" && r.status === "active",
  );
  const additions = Object.entries(desired)
    .filter(([, q]) => q > 0)
    .map(([addonKey, quantity]) => ({ addonKey, quantity }));
  const removals = currentIndividual
    .filter((r) => !(Number(desired[r.addon_key] ?? 0) > 0))
    .map((r) => r.addon_key);
  return applyGovernedAddonChange(
    ctx,
    archetype,
    { additions, removals },
    { ...opts, correlationId },
  );
}

/**
 * Governed "return to the Free base": schedule period-end removal of EVERY currently-live add-on
 * (individual + bundle-sourced), so the workspace lands back on the free plan at period end without
 * deleting any data. A no-op (already on Free) is a clean success.
 */
export async function applyGovernedGoFree(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: GovernedChangeOptions = {},
): Promise<AddonChangeResult> {
  const correlationId = opts.correlationId ?? newCorrelationId();
  if (!can(archetype, "billing.manage")) {
    throw new SubscriptionChangeError("authorization", correlationId, "billing.manage required");
  }
  const state = await readCurrentAddonState(ctx);
  const removals = state.rows.filter((r) => r.status === "active").map((r) => r.addon_key);
  if (removals.length === 0) return { added: 0, removalScheduled: 0, removeAt: null };
  return applyGovernedAddonChange(
    ctx,
    archetype,
    { additions: [], removals },
    { ...opts, correlationId },
  );
}

/** Classify a DB-wall applier message onto a governed error code (kept out of the user's face). */
function governedApplierError(message: string, correlationId: string): SubscriptionChangeError {
  if (/is not purchasable/.test(message)) {
    if (/credential_gated/.test(message))
      return new SubscriptionChangeError("credential_gated", correlationId, message);
    if (/d1_gated/.test(message))
      return new SubscriptionChangeError("d1_gated", correlationId, message);
    if (/deferred/.test(message))
      return new SubscriptionChangeError("deferred", correlationId, message);
    return new SubscriptionChangeError("unavailable_addon", correlationId, message);
  }
  if (/unknown addon/.test(message))
    return new SubscriptionChangeError("unknown_addon", correlationId, message);
  return new SubscriptionChangeError("internal", correlationId, message);
}

/** Read-only-state gate for the governed path (classified error instead of a raw BillingReadOnlyError). */
async function assertTenantWritableGoverned(ctx: Ctx, correlationId: string): Promise<void> {
  try {
    await assertTenantWritable(ctx);
  } catch (err) {
    if (err instanceof BillingReadOnlyError) {
      throw new SubscriptionChangeError("read_only", correlationId, err.message);
    }
    throw err;
  }
}

/**
 * Governed cancellation (test/trial): reuse the EXISTING state machine (no second machine) to compute
 * the target for a 'canceled' signal, then apply it through the shared `applyTransition` writer,
 * attributed owner_action. No provider call, no charge. An illegal move (e.g. an already-cancelled or
 * purged org) is a classified invalid_transition — never a silent no-op reported as success.
 */
export async function applyGovernedCancellation(
  ctx: Ctx,
  archetype: RoleArchetype,
  opts: GovernedChangeOptions = {},
): Promise<{ from: BillingState; to: BillingState }> {
  const correlationId = opts.correlationId ?? newCorrelationId();
  if (!can(archetype, "billing.manage")) {
    throw new SubscriptionChangeError("authorization", correlationId, "billing.manage required");
  }
  const from = await withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select billing_state from public.org_plan_state where org_id = ${ctx.orgId}`)) as unknown as Array<{
      billing_state: BillingState;
    }>;
    return rows[0]?.billing_state ?? "active";
  });
  const res = nextForEvent(from, "canceled");
  if (res.to === null) {
    throw new SubscriptionChangeError("invalid_transition", correlationId, res.reason);
  }
  const { db, end } = createAppDb({ max: 1 });
  try {
    await applyTransition(db, ctx.orgId, from, res.to, res.reason, Date.now(), {
      eventType: "owner_action.cancel",
      via: "owner_action",
    });
  } finally {
    await end();
  }
  logger.info(
    { orgId: ctx.orgId, correlationId, from, to: res.to },
    "governed cancellation applied",
  );
  return { from, to: res.to };
}

export type SubscriptionView = {
  planKey: string;
  billingState: string;
  readOnly: boolean;
  periodEnd: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlanKey: string | null;
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
             cancel_at_period_end, scheduled_plan_key
      from public.org_plan_state where org_id = ${ctx.orgId}`)) as unknown as Array<{
      plan_key: string;
      billing_state: string;
      period_end: string | null;
      trial_end: string | null;
      cancel_at_period_end: boolean;
      scheduled_plan_key: string | null;
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
      scheduledPlanKey: s.scheduled_plan_key,
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

// ── PART B: tenant-visible subscription AUDIT HISTORY ───────────────────────────────────────────
export type SubscriptionAuditEntry = {
  id: string;
  action: string;
  summary: string;
  createdAt: string;
  /** Derived provenance the tenant sees (never the platform audit stream). */
  source: AuditProvenance;
  /** The scheduled effective date, when the change is period-end scheduled (else null). */
  effectiveDate: string | null;
  /** A coarse status for the row (applied / scheduled) — display only. */
  status: "applied" | "scheduled";
};

/** Which audit actions are subscription-relevant (tenant-visible history). */
const SUBSCRIPTION_AUDIT_ACTIONS_LIKE = "subscription.%";

/** Derive the tenant-visible provenance for an audit row from its action + after_data marker. */
function deriveAuditSource(action: string, after: Record<string, unknown> | null): AuditProvenance {
  if (action.startsWith("onboarding.")) return "onboarding";
  const via = after?.via;
  if (via === "owner_action" || via === "platform_override" || via === "provider_event") return via;
  // Legacy rows written before the `via` marker: attribute to the provider-event path (the only
  // writer that existed then) — honest and stable.
  return "provider_event";
}

/**
 * Read the org's OWN subscription audit history (tenant-scoped by RLS — a tenant sees only its own
 * rows; the platform audit stream stays separate). Covers tier changes, add-on add/remove, quantity
 * changes, scheduled changes, cancellations and the onboarding-recorded choice. billing.view-gated.
 */
export async function readSubscriptionAuditHistory(
  ctx: Ctx,
  archetype: RoleArchetype,
  limit = 50,
): Promise<SubscriptionAuditEntry[]> {
  assertCan(archetype, "billing.view");
  const capped = Math.min(200, Math.max(1, Math.trunc(limit)));
  return withCtx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      select id::text as id, action, summary, created_at::text as created_at, after_data
      from public.audit_log
      where org_id = ${ctx.orgId}
        and (action like ${SUBSCRIPTION_AUDIT_ACTIONS_LIKE} or action = 'onboarding.tier_selected')
      order by created_at desc
      limit ${capped}`)) as unknown as Array<{
      id: string;
      action: string;
      summary: string;
      created_at: string;
      after_data: Record<string, unknown> | null;
    }>;
    return rows.map((r) => {
      const after = r.after_data;
      const effectiveDate =
        after && typeof after.remove_at === "string" && after.remove_at.length > 0
          ? after.remove_at
          : null;
      const scheduled =
        effectiveDate !== null ||
        after?.status === "removal_scheduled" ||
        r.action === "subscription.downgrade_scheduled";
      return {
        id: r.id,
        action: r.action,
        summary: r.summary,
        createdAt: r.created_at,
        source: deriveAuditSource(r.action, after),
        effectiveDate,
        status: scheduled ? ("scheduled" as const) : ("applied" as const),
      };
    });
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
