# Dead-Letter Recovery (outbox domain events)

**What a dead-letter is:** a `domain_event` row still unprocessed after
`MAX_ATTEMPTS` (20) relay attempts (`src/platform/events/relay.ts`). The relay
alarms on every tick that sees one — ERROR log `domain_event dead-letter …` +
Sentry `outbox_dead_letter` (page-worthy, Bible §15.4) — and `/api/health`
reports `checks.queue.dead_lettered > 0` with `alert: true`.

Dead-letters are **never auto-redriven** (a poison event would loop forever).
Recovery is a deliberate operator action **after the root cause is fixed**.

## Diagnose

1. `/api/health` → `checks.queue` for counts; the relay's ERROR log lines carry
   a sample of `{id, name, attempts}`.
2. Inspect the rows (read-only; via the migration/tooling connection —
   `DIRECT_URL`, never the app runtime):
   ```sql
   select id, org_id, name, version, attempts, last_error, occurred_at
   from public.domain_event
   where processed_at is null and attempts >= 20
   order by occurred_at;
   ```
3. Classify by `last_error`:
   - **Transport** (Inngest unreachable / unconfigured window) → safe to redrive.
   - **Consumer bug** (handler threw) → fix + deploy first, then redrive.
   - **Poison payload** (schema violation — should be impossible via the
     registry) → treat as a defect; do NOT redrive until the consumer tolerates
     it or the event is intentionally purged.

## Redrive (after the fix is deployed)

Preferred — through the platform surface (same guard as the relay:
platform-task session, no org context):

```ts
// pnpm tsx -e:
import { redriveDeadLetters } from "@/platform/events";
console.log("redriven:", await redriveDeadLetters("manual-redrive"));
```

This resets `attempts` to 0 via `app.redrive_dead_lettered_domain_events`;
the next relay tick re-publishes. Consumers are idempotent (keyed by event id,
Bible §8.7/§8.11) — a duplicate delivery is harmless.

## Verify

- `/api/health` → `checks.queue.dead_lettered` returns to 0 and
  `unprocessed` drains to 0 within a few relay ticks.
- The consumer's effect exists (e.g. derivatives present for `file.uploaded`).

## Abandoned dead-letters

If an event must NOT be delivered (intentional abandonment), leave it: the
retention task purges dead-letters older than `DEAD_LETTER_RETENTION` (30 days)
via `app.purge_dead_lettered_domain_events`. Record the decision in the
incident/ticket — an intentionally dropped domain event is an audit-relevant
fact.
