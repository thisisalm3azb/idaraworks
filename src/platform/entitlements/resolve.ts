/**
 * Entitlement resolution (v1 §13; S0 checklist §15 AC).
 * Resolved entitlements = plan values, with per-org overrides layered on top.
 * Cached per org with explicit invalidation on any override/plan write
 * (BUILD_BIBLE §5.8; §8.9 — invalidation story shipped with the cache). The
 * in-memory TTL cache is the correct MVP-scale implementation; the cross-instance
 * push-invalidation form is a documented scaling step (BUILD_BIBLE §12), not debt.
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
const cache = new Map<string, { at: number; value: ResolvedEntitlements }>();

/** Explicit invalidation — call on any plan/override write for the org. */
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

    const features: Record<string, boolean> = {};
    const limits: Record<string, number | null> = {};
    for (const row of planEnt) {
      if (row.kind === "feature") features[row.key] = row.enabled ?? false;
      else limits[row.key] = row.limit_value === null ? null : Number(row.limit_value);
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
