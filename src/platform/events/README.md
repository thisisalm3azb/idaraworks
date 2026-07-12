# Domain events — conventions (BUILD_BIBLE §8.6–8.7; S0 checklist §7)

The event bus is a **transactional outbox**: emitters write a `domain_event` row
_inside their mutation transaction_; a relay publishes it to Inngest after commit
and marks it processed. This gives at-least-once delivery with no lost or phantom
events and no network call inside a DB transaction.

## Rules

1. **Names are past-tense facts.** `file/uploaded`, `invoice/paid` — the thing
   already happened. Never imperative (`send/email`).
2. **Payloads are versioned.** Every event has a `version` in `registry.ts`. A
   breaking payload change bumps the version; consumers handle the versions they
   know.
3. **Every event is org-scoped.** `orgId` + `actorUserId` are injected from `ctx`
   by `emitEvent` (never trusted from callers) and validated with the rest of the
   payload against the registry schema.
4. **Consumers are idempotent.** The relay keys each Inngest send by the
   `domain_event.id`, so a duplicate delivery is de-duplicated; handlers must also
   tolerate re-delivery (guard their own writes — e.g. the image pipeline's
   `status = 'pending'` flip guard).
5. **Org-scoped consumers use `defineOrgFunction`.** It re-verifies the payload's
   `(org, actor)` against the DB before the handler runs (doc 10 #9) — so
   re-verification is impossible to forget. Platform tasks (the relay, retention)
   run without an org context.

## How to emit

- **Alongside a mutation (atomic):** `command(ctx, { audit, events: [{ name, payload }] }, fn)`
  — the event row commits with the mutation.
- **Standalone (no mutation):** `publishEvent({ name, data })` — durably writes to
  the outbox in its own transaction.

## Delivery, dead-letter, retention

- `outbox-relay` (cron ~1 min) claims a batch (`SKIP LOCKED`, attempts bumped),
  sends to Inngest, marks processed / records error.
- After `MAX_ATTEMPTS` an event is **dead-lettered** → an ERROR ops-log alarm
  (the Sentry `captureException` channel wires in with observability, Phase I).
- `outbox-retention` (nightly) purges processed events older than 90 days
  (Appendix B — the bus is transport, not a record).

## The platform-task boundary

The relay reaches events cross-org through `SECURITY DEFINER` functions guarded by
`app.assert_platform_task()`, which **rejects any session that has an org context
set**. Tenant requests always run inside `withCtx` (org GUC set), so they can
never read or claim the bus; the relay uses a dedicated no-context client.
