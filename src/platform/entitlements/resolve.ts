/**
 * Entitlement resolution (v1 §13; S0 checklist §15 AC).
 * Resolved entitlements = plan values, with per-org overrides layered on top.
 *
 * Freshness (MVP): a per-instance TTL cache (60s). This is the actual freshness
 * mechanism at MVP scale — plan/override writes land in S9 from OUT-OF-PROCESS
 * actors (billing webhook, platform admin, direct SQL) with no app_user write
 * grant, so they cannot reach this in-memory Map; a stale read self-heals within
 * one TTL. invalidateEntitlements() is provided for SAME-PROCESS callers (and to
 * keep tests deterministic). Cross-instance push-invalidation is the documented
 * scaling step (BUILD_BIBLE §12), out of scope for Phase D.
 *
 * LAW (freeze FR-9): reads/exports are NEVER blocked by entitlements. checkLimit
 * governs the ability to ADD, not to see.
 */
import { sql, withCtx, type Ctx } from "@/platform/tenancy";
import {
  isFeatureKey,
  isLimitKey,
  type EntitlementKey,
  type FeatureKey,
  type LimitKey,
} from "./catalogue";
import { getAddon } from "./addons";

export type ResolvedEntitlements = {
  planKey: string;
  billingState: string;
  features: Record<string, boolean>;
  limits: Record<string, number | null>; // null = unlimited
};

class UnknownEntitlementKeyError extends Error {
  constructor(key: string) {
    super(`Unknown entitlement key: ${key}`);
    this.name = "UnknownEntitlementKeyError";
  }
}

const CACHE_TTL_MS = 60_000;
// Bounded so a long-lived instance serving many orgs cannot grow the cache
// without limit (entries also expire by TTL). On overflow, evict the oldest
// insertion — Map preserves insertion order, so the first key is the oldest.
const CACHE_MAX_ENTRIES = 5_000;
const cache = new Map<string, { at: number; value: ResolvedEntitlements }>();

/** Same-process invalidation (see header). Call after a same-process plan/override write. */
export function invalidateEntitlements(orgId: string): void {
  cache.delete(orgId);
}

async function loadResolved(ctx: Ctx): Promise<ResolvedEntitlements> {
  return withCtx(ctx, async (tx) => {
    const planRows = (await tx.execute(sql`
      select plan_key, billing_state from public.org_plan_state
      where org_id = ${ctx.orgId}
    `)) as unknown as Array<{ plan_key: string; billing_state: string }>;
    // Every org has a plan (assigned atomically at creation). Absence is a bug,
    // not a silent free pass — fail loud.
    const plan = planRows[0];
    if (!plan) {
      throw new Error(`org ${ctx.orgId} has no plan state`);
    }

    const planEnt = (await tx.execute(sql`
      select e.key, e.kind, pe.enabled, pe.limit_value
      from public.plan_entitlement pe
      join public.entitlement_def e on e.key = pe.entitlement_key
      where pe.plan_key = ${plan.plan_key}
    `)) as unknown as Array<{
      key: string;
      kind: "feature" | "limit";
      enabled: boolean | null;
      limit_value: string | null;
    }>;

    const overrides = (await tx.execute(sql`
      select o.entitlement_key as key, e.kind, o.enabled, o.limit_value
      from public.org_entitlement_override o
      join public.entitlement_def e on e.key = o.entitlement_key
      where o.org_id = ${ctx.orgId}
    `)) as unknown as Array<{
      key: string;
      kind: "feature" | "limit";
      enabled: boolean | null;
      limit_value: string | null;
    }>;

    // Active add-ons (0065): the layer between plan base and org overrides.
    // removal_scheduled still counts — the org paid through period end; the
    // lifecycle sweep flips it to 'removed' when remove_at passes.
    const addonRows = (await tx.execute(sql`
      select addon_key, quantity from public.org_addon
      where org_id = ${ctx.orgId} and status in ('active','removal_scheduled')
    `)) as unknown as Array<{ addon_key: string; quantity: number }>;

    const features: Record<string, boolean> = {};
    const limits: Record<string, number | null> = {};
    for (const row of planEnt) {
      if (row.kind === "feature") features[row.key] = row.enabled ?? false;
      else limits[row.key] = row.limit_value === null ? null : Number(row.limit_value);
    }
    // Add-on merge: features OR; numeric limit deltas ADD × quantity onto the
    // plan base (a null/unlimited base stays unlimited; a missing base is 0).
    for (const row of addonRows) {
      const def = getAddon(row.addon_key);
      if (!def) continue; // unknown key in DB (never expected — parity-tested)
      for (const f of def.features) features[f] = true;
      const qty = Math.max(1, Number(row.quantity) || 1);
      for (const [k, delta] of Object.entries(def.limitDeltas)) {
        const base = limits[k];
        if (base === null) continue; // unlimited stays unlimited
        limits[k] = (base ?? 0) + delta * qty;
      }
    }
    for (const row of overrides) {
      if (row.kind === "feature") features[row.key] = row.enabled ?? false;
      else limits[row.key] = row.limit_value === null ? null : Number(row.limit_value);
    }

    return {
      planKey: plan.plan_key,
      billingState: plan.billing_state,
      features,
      limits,
    };
  });
}

export async function resolveEntitlements(ctx: Ctx): Promise<ResolvedEntitlements> {
  const hit = cache.get(ctx.orgId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await loadResolved(ctx);
  cache.set(ctx.orgId, { at: Date.now(), value });
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

export async function hasFeature(ctx: Ctx, key: FeatureKey): Promise<boolean> {
  if (!isFeatureKey(key)) throw new UnknownEntitlementKeyError(key);
  const ent = await resolveEntitlements(ctx);
  return ent.features[key] ?? false;
}

/** Returns the numeric limit, or null for unlimited. */
export async function getLimit(ctx: Ctx, key: LimitKey): Promise<number | null> {
  if (!isLimitKey(key)) throw new UnknownEntitlementKeyError(key);
  const ent = await resolveEntitlements(ctx);
  return key in ent.limits ? ent.limits[key]! : 0;
}

export type LimitCheck = { allowed: boolean; limit: number | null; current: number };

/**
 * checkLimit: is there room to add one more? `current` is the caller's counted
 * usage (limits govern ADD, never read — freeze FR-9). Unlimited => always allowed.
 */
export async function checkLimit(ctx: Ctx, key: LimitKey, current: number): Promise<LimitCheck> {
  const limit = await getLimit(ctx, key);
  if (limit === null) return { allowed: true, limit: null, current };
  return { allowed: current < limit, limit, current };
}

export function assertKnownKey(key: string): asserts key is EntitlementKey {
  if (!isFeatureKey(key) && !isLimitKey(key)) throw new UnknownEntitlementKeyError(key);
}

/** A module ADD path was used without its capability (add-on model). Gates
 * govern ADD/mutate entry points only — reads/exports are never blocked (FR-9). */
export class CapabilityRequiredError extends Error {
  constructor(public readonly key: FeatureKey) {
    super(`this capability requires an add-on (${key})`);
    this.name = "CapabilityRequiredError";
  }
}

/** The standard capability gate for service CREATE/mutate entry points. */
export async function requireCapability(ctx: Ctx, key: FeatureKey): Promise<void> {
  if (!(await hasFeature(ctx, key))) throw new CapabilityRequiredError(key);
}

/**
 * Billing states in which a tenant workspace is READ-ONLY (v1 §13 / FR-9): a non-paying or
 * cancelled org may still SEE and EXPORT everything, but cannot ADD/mutate. Lives in the platform
 * entitlement layer so the audited-mutation chokepoint (command()) can enforce it without importing
 * a module (BUILD_BIBLE §3.3). suspended/cancelled = failed-payment/cancel read-only; purge_pending/
 * purged = post-cancellation removal window.
 */
export const READ_ONLY_BILLING_STATES: ReadonlySet<string> = new Set([
  "suspended",
  "cancelled",
  "purge_pending",
  "purged",
]);

export function isReadOnlyBillingState(state: string): boolean {
  return READ_ONLY_BILLING_STATES.has(state);
}

export class BillingReadOnlyError extends Error {
  constructor(public readonly state: string) {
    super(`workspace is read-only (billing state: ${state})`);
    this.name = "BillingReadOnlyError";
  }
}
