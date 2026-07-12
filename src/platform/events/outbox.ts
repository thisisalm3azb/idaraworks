/**
 * Transactional outbox emitter (BUILD_BIBLE §8.6/§8.8; S0 checklist §7.2).
 * emitEvent inserts a domain_event row INSIDE the caller's transaction — atomic
 * with the mutation that emits it, and with NO network call in the tx. The relay
 * (relay.ts) publishes it to Inngest post-commit. org_id + actor_user_id are
 * taken from ctx (never the caller), then merged into the payload so the fact is
 * self-describing; the payload is validated against the versioned registry.
 */
import { sql, type Ctx, type TenantTx } from "@/platform/tenancy";
import { eventVersion, validateEventPayload, type EventName } from "./registry";

export type EventSpec = {
  name: EventName;
  /** Event-specific fields; orgId/actorUserId are injected from ctx. */
  payload?: Record<string, unknown>;
};

export async function emitEvent(tx: TenantTx, ctx: Ctx, event: EventSpec): Promise<void> {
  const full = { ...(event.payload ?? {}), orgId: ctx.orgId, actorUserId: ctx.userId };
  const payload = validateEventPayload(event.name, full);
  await tx.execute(sql`
    insert into public.domain_event (org_id, name, version, payload, actor_user_id)
    values (${ctx.orgId}, ${event.name}, ${eventVersion(event.name)},
            ${JSON.stringify(payload)}::jsonb, ${ctx.userId})
  `);
}
