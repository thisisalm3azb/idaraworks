/**
 * The command path (BUILD_BIBLE §4.5, §8.8; doc 01 D-1.8).
 * Every audited mutation runs through `command`: it executes the mutation and
 * writes the audit_log row (and optional activity row) in the SAME transaction,
 * so the audit trail is atomic with the change — if the mutation rolls back the
 * audit does too, and if the audit write fails the mutation rolls back.
 *
 * audit_log = security/config/financial mutations (compliance stream).
 * activity   = operational narrative on L2/L4 entities (tenant-visible).
 * Feature code never writes these tables directly: an ESLint no-restricted-syntax
 * rule (eslint.config.mjs) forbids `insert into public.audit_log|activity` string
 * literals outside src/platform/audit/**. Two SECURITY DEFINER bootstrap paths
 * (app.create_org_with_owner, app.accept_invite) write their own audit row inside
 * the function body — that is still ONE atomic transaction with the mutation, and
 * is the only SQL-side writer (migrations are not app code).
 */
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import type { AttachableType, AuditEntityType } from "@/platform/registries";
import { emitEvent, type EventSpec } from "@/platform/events/outbox";
import { isReadOnlyBillingState, BillingReadOnlyError } from "@/platform/entitlements/resolve";

export type AuditSpec = {
  action: string; // e.g. 'membership.deactivate'
  entityType: AuditEntityType;
  entityId?: string;
  summary: string;
  before?: unknown;
  after?: unknown;
};

export type ActivitySpec = {
  entityType: AttachableType;
  entityId: string;
  verb: string; // past tense
  summary: string;
};

async function writeAudit(tx: TenantTx, ctx: Ctx, a: AuditSpec): Promise<void> {
  await tx.execute(sql`
    insert into public.audit_log
      (org_id, actor_user_id, action, entity_type, entity_id, summary, before_data, after_data)
    values (${ctx.orgId}, ${ctx.userId}, ${a.action}, ${a.entityType},
            ${a.entityId ?? null}, ${a.summary},
            ${a.before === undefined ? null : JSON.stringify(a.before)}::jsonb,
            ${a.after === undefined ? null : JSON.stringify(a.after)}::jsonb)
  `);
}

async function writeActivity(tx: TenantTx, ctx: Ctx, act: ActivitySpec): Promise<void> {
  await tx.execute(sql`
    insert into public.activity (org_id, actor_user_id, entity_type, entity_id, verb, summary)
    values (${ctx.orgId}, ${ctx.userId}, ${act.entityType}, ${act.entityId}, ${act.verb}, ${act.summary})
  `);
}

/**
 * Run a mutation and record it. The mutation body receives the same transaction
 * the audit/activity rows are written in. `audit` (and `activity`) may be a
 * value or a function of the mutation's result — so an audit summary can name
 * what actually changed (e.g. the deactivated member).
 */
export async function command<T>(
  ctx: Ctx,
  spec: {
    audit: AuditSpec | ((result: T) => AuditSpec);
    activity?: ActivitySpec | ((result: T) => ActivitySpec);
    /** Domain events emitted in the SAME transaction (transactional outbox) —
     * atomic with the mutation; the relay publishes them post-commit (§8.6). */
    events?: EventSpec[] | ((result: T) => EventSpec[]);
  },
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return withCtx(ctx, async (tx) => {
    // FR-9 (v1 §13): a read-only billing state (suspended / cancelled / purge_pending / purged)
    // blocks every audited MUTATION — the tenant may still READ and EXPORT, but not ADD/change.
    // command() is the single chokepoint for tenant mutations, so enforcing here covers every
    // add path (jobs, reports, supply, expenses, invoices, config, …) without per-service drift.
    // Read within the same tx so a just-suspended org is blocked immediately (no cache staleness).
    const ps = (await tx.execute(sql`
      select billing_state from public.org_plan_state where org_id = ${ctx.orgId}`)) as unknown as Array<{
      billing_state: string;
    }>;
    if (ps[0] && isReadOnlyBillingState(ps[0].billing_state)) {
      throw new BillingReadOnlyError(ps[0].billing_state);
    }
    const result = await fn(tx);
    const audit = typeof spec.audit === "function" ? spec.audit(result) : spec.audit;
    await writeAudit(tx, ctx, audit);
    if (spec.activity) {
      const activity = typeof spec.activity === "function" ? spec.activity(result) : spec.activity;
      await writeActivity(tx, ctx, activity);
    }
    if (spec.events) {
      const events = typeof spec.events === "function" ? spec.events(result) : spec.events;
      for (const event of events) await emitEvent(tx, ctx, event);
    }
    return result;
  });
}

/**
 * Write an activity row INSIDE an existing transaction — for callers that must
 * keep the narrative row atomic with their own mutation (e.g. createComment
 * inserts the comment and this activity row in one tx). §4.12 one-command-one-tx.
 */
export async function recordActivityIn(tx: TenantTx, ctx: Ctx, act: ActivitySpec): Promise<void> {
  await writeActivity(tx, ctx, act);
}

/** Record an operational activity entry alone (no audit) — for L2/L4 narrative. */
export async function recordActivity(ctx: Ctx, act: ActivitySpec): Promise<void> {
  await withCtx(ctx, (tx) => writeActivity(tx, ctx, act));
}
