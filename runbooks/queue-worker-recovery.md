# Queue + worker recovery

**Audience:** the operator recovering IdaraWorks' event pipeline — the transactional outbox, the
Inngest worker fleet, and dead-lettered events.

**Scope:** this is the *unified* recovery runbook. It covers three failure surfaces that share one
durable substrate (the `public.domain_event` outbox):

1. **Outbox relay + dead-letters** — events written but not delivered, or exhausted.
2. **Inngest worker health** — the fleet that consumes delivered events + runs the crons.
3. **Stuck / aged unprocessed events** — the backlog gauge climbing.

> Pilot context: the default pilot state has **Inngest unconfigured** (see
> `runbooks/credential-disabled-operations.md`). In that state a *climbing* `checks.queue.unprocessed`
> is **expected**, not an incident — events are being written and durably queued for a relay that
> is intentionally dormant. Use this runbook when the backlog climbs *after* Inngest is provisioned,
> when dead-letters appear, or when you need to drain the outbox on-demand during the pilot.

---

## The model in one paragraph

Every domain event is inserted as a `public.domain_event` row **inside the transaction that emits
it** (`src/platform/events/outbox.ts`) — atomic with the mutation, no network call in the tx. The
**relay** (`src/platform/events/relay.ts`) is a **platform task** (no tenant context; admitted by
the DB's `assert_platform_task()` guard) that claims a batch (`RELAY_BATCH = 50`, `SKIP LOCKED`),
bumps `attempts` **at claim**, publishes each to Inngest **keyed by event id** (dedup /
at-least-once), and marks it processed. A row still unprocessed after `MAX_ATTEMPTS = 20` attempts
is a **dead-letter**. Consumers are idempotent by event id, so a duplicate delivery is harmless.

**First diagnostic, always:** `GET https://idaraworks.vercel.app/api/health` → `checks.queue` and
`checks.inngest`.

```json
"queue":   { "ok": true, "unprocessed": 0, "oldest_unprocessed_age_s": 0, "dead_lettered": 0, "alert": false },
"inngest": { "configured": true, "status": "configured" }
```

| Field | Meaning | Healthy |
| --- | --- | --- |
| `checks.queue.unprocessed` | domain_event rows not yet delivered | 0 (steady) |
| `checks.queue.oldest_unprocessed_age_s` | age of the oldest undelivered row | small + not growing |
| `checks.queue.dead_lettered` | rows past `MAX_ATTEMPTS` | **0** |
| `checks.queue.alert` | `dead_lettered > 0` | `false` |
| `checks.inngest.status` | `configured` \| `unconfigured` | matches intent |

Source of the gauges: `app.outbox_stats(MAX_ATTEMPTS)` via `src/platform/observability/health.ts`.
Note: a dead-letter sets `alert: true` but **does not** 503 the app — `checks.queue` shares the
DB dependency already gated by `checks.db`.

---

## Decision tree

```
/api/health
│
├─ checks.inngest.status = "unconfigured"?
│     └─ Fleet is DORMANT by design. unprocessed climbing is EXPECTED.
│        • To deliver now: run the relay on-demand (§B) or provision Inngest (§C).
│
├─ checks.queue.dead_lettered > 0  (alert:true)?
│     └─ Go to §A (dead-letter recovery) — fix root cause, then redrive.
│
├─ checks.queue.unprocessed climbing AND inngest "configured"?
│     └─ Go to §D (stuck/aged backlog) — the relay or workers aren't draining.
│
└─ all zero + configured?  → healthy. Nothing to do.
```

---

## §A. Dead-letter recovery

A dead-letter is a poison-or-blocked event that exhausted all 20 attempts. It is **never
auto-redriven** (that would loop a poison event forever). Recovery is a deliberate operator action
**after the root cause is fixed and deployed**.

This section is the operational summary; **`runbooks/dead-letter-recovery.md` is the authoritative
detail** (diagnose → classify → redrive → verify → abandonment). Follow it. In brief:

1. **Diagnose.** `/api/health` → `checks.queue.dead_lettered` for the count; the relay's ERROR log
   `"domain_event dead-letter — events exceeded max attempts"` carries a sample of
   `{id, name, attempts}` (and Sentry `outbox_dead_letter` if Sentry is provisioned — during the
   pilot Sentry is typically off, so **the log line + the health gauge are your signal**).
2. **Inspect** the rows read-only via the migration/tooling connection (`DIRECT_URL`, **never** the
   app runtime):
   ```sql
   select id, org_id, name, version, attempts, last_error, occurred_at
   from public.domain_event
   where processed_at is null and attempts >= 20
   order by occurred_at;
   ```
3. **Classify by `last_error`:** *transport* (Inngest unreachable/unconfigured window → safe to
   redrive), *consumer bug* (fix + deploy first), *poison payload* (do not redrive until the
   consumer tolerates it or the event is intentionally purged).
4. **Redrive — only after the fix is deployed:**
   ```
   pnpm tsx tooling/scripts/redrive-dead-letters.ts
   ```
   This calls `redriveDeadLetters()` → `app.redrive_dead_lettered_domain_events`, resetting
   `attempts` to 0 through the same platform-task surface the relay uses; the next relay tick
   re-publishes. Consumers are idempotent, so duplicates are harmless. The script prints
   `dead-lettered before` / `redriven` counts.
5. **Verify.** `/api/health` → `checks.queue.dead_lettered` returns to 0 and `unprocessed` drains
   within a few relay ticks; confirm the consumer's effect now exists (e.g. derivatives for
   `file.uploaded`).
6. **Abandonment.** If an event must *not* be delivered, leave it: the retention task purges
   dead-letters older than `DEAD_LETTER_RETENTION = 30 days`. Record the decision in the ticket —
   an intentionally dropped domain event is an audit-relevant fact.

---

## §B. Drain the outbox on-demand (relay not running)

Use this when Inngest is dormant (pilot default) or the `outbox-relay` cron is not firing, and you
need accumulated events delivered now. The relay is a **plain function** — the cron is only a
wrapper (`src/workers/functions/outbox-relay.ts` wraps `relayOutbox`).

**What the relay does per tick** (`relayOutbox` in `src/platform/events/relay.ts`): claim up to
`RELAY_BATCH = 50` unprocessed events over one platform-task connection, publish each to Inngest
by id, mark processed; returns `{ claimed, sent, failed }`. `checkDeadLetters` then alarms on any
exhausted rows. To fully drain a backlog larger than 50, run it repeatedly until `claimed` is 0
(the integration tests drain this way).

**Prerequisites:** `.env.local` present (so the platform-task DB client can connect), and — for
sends to actually reach a worker — **Inngest must be configured**. If Inngest is *unconfigured*,
`relayOutbox` will attempt to send in dev-mode and the events won't reach a cloud worker; in the
pilot the correct sequence is: **provision Inngest first (§C), then the live cron drains the
backlog automatically** (its consumers are idempotent, so the pre-provisioning accumulation is
delivered exactly-once-effectively on first run).

> There is no shipped `pnpm` wrapper for the relay itself (unlike redrive). Run it via `pnpm tsx`
> against a one-line entrypoint that imports `relayOutbox` from `@/platform/events`, or rely on the
> `outbox-relay` cron once Inngest is up. Do **not** invent a tenant-context path — the relay must
> run as a platform task (`createAppDb({ max: 1 })`, no GUCs) or the DB guard rejects it.

**Related on-demand platform tasks** (same pattern, all idempotent, all platform-context):
`purgeProcessedEvents()` (retention), `sweepLifecycle()` / `runReconciliation()` (subscription),
`dispatchNightly()` / `runOrgNightly()` (exceptions), `pruneRetention()` (row retention). See the
table in `runbooks/credential-disabled-operations.md` §1.

---

## §C. Inngest worker health

The fleet (24 functions, `src/workers/index.ts`) is served at `/api/inngest`. Recovery here means
confirming the route, the registered functions, signature enforcement, and that the crons fire.

**Authoritative procedure: `runbooks/inngest-provisioning.md` (the four-step verify).** Summary:

1. **Route status.** `GET https://idaraworks.vercel.app/api/inngest`:
   - `503 {status: "inngest_unconfigured"}` → keys not provisioned (the pilot default). This is the
     explicit, expected pre-provisioning state, **not** a crash. Provision per
     `inngest-provisioning.md`. Also confirm `/api/health` → `checks.inngest.status =
     "unconfigured"`.
   - `200` (introspection) → configured and serving.
   - Anything else (generic 500) → investigate; the guard exists specifically to prevent an
     unexplained 500 for the unconfigured case, so a real 500 is a genuine fault.
2. **App sync.** In the Inngest dashboard the `idaraworks` app must show all registered functions
   (relay, retention, the nightly dispatch, the lifecycle + retention-prune crons, and every
   `defineOrgFunction` consumer). A missing function means the serve list drifted — but the serve
   route is generated from `workerFunctions`, so re-sync after any deploy that adds one.
3. **Signed invocation.** Invoke `demo-heartbeat` from the dashboard with a real
   `{orgId, actorUserId, nonce}` — the run must **succeed** (proves signature verification + the
   org re-verification harness end-to-end). A **forged** (org, actor) pair must **fail** with
   `OrgVerificationError` — that failure is the harness (`src/workers/harness.ts`) working, not a
   bug.
4. **Rejection.** An **unsigned** `POST /api/inngest` must be **rejected** (401/400), never
   executed. Never set `INNGEST_DEV=1` in production — it would accept unsigned invocations.

**Individual worker failures:** each `defineOrgFunction` handler logs `"worker handler failed"`
with `{worker, org_id, request_id, run_id}` and (if Sentry is up) captures it tagged by `worker` /
`org_id`, then **rethrows** so Inngest's own retry/backoff (`retries`, default 3) applies. Repeated
failure past retries is what produces a dead-letter → §A. Read these in Vercel logs filtered by the
`worker` id or the `request_id` from the health/error surface.

---

## §D. Stuck / aged unprocessed events (Inngest configured, backlog not draining)

Symptom: `checks.inngest.status = "configured"` **and** `checks.queue.unprocessed` /
`oldest_unprocessed_age_s` are climbing and not draining. The relay claims but isn't completing.

**Diagnose in order:**

1. **Is the `outbox-relay` cron running?** Check the Inngest dashboard for `outbox-relay` run
   history (it should fire every minute). If it isn't firing, the app sync is stale or the cron is
   paused — re-sync (§C step 2).
2. **Are claims failing to send?** The relay bumps `attempts` **at claim**; a send that throws
   records the error via `app.record_domain_event_error` and retries next tick. Inspect
   `last_error` on the aging rows (SQL in §A step 2). A consistent transport error means Inngest is
   unreachable — check keys/rotation (`inngest-provisioning.md` → Rotation) and Inngest status.
3. **Is one poison event blocking perception but not progress?** `SKIP LOCKED` means a stuck row
   doesn't block others — the batch moves on. If `unprocessed` is large but `oldest_unprocessed_age_s`
   keeps growing for a *specific* set, those are heading toward dead-letter; let them reach 20
   attempts and handle via §A, or fix the consumer first.
4. **Attempt-consumption note (by design):** because attempts bump at claim, a successful *send*
   whose subsequent `mark_processed` fails will consume an attempt and re-send next tick (Inngest
   de-dups by id — harmless). This is the deliberate at-least-once trade-off; it prevents poison
   loops. `MAX_ATTEMPTS = 20` at ~1-min cadence tolerates a ~20-minute queue outage before
   dead-lettering a genuinely deliverable event.

**Recover:**

- Transport outage that has since cleared, events **not yet** dead-lettered → they drain on their
  own on the next healthy tick; no action.
- Events **already** dead-lettered → §A (fix root cause, then `redrive-dead-letters.ts`).
- Backlog you must clear immediately (e.g. right after provisioning Inngest) → the live cron drains
  it; or run the relay on-demand (§B) repeatedly until `claimed` is 0.

**Verify recovery:** `/api/health` → `checks.queue.unprocessed` and `oldest_unprocessed_age_s`
return toward 0, `dead_lettered = 0`, `alert = false`. `pnpm smoke:prod` asserts
`queue has no dead-letters` and `health queue` ok as a final gate.

---

## Constants (single source of truth — `src/platform/events/relay.ts`)

| Constant | Value | Meaning |
| --- | --- | --- |
| `RELAY_BATCH` | 50 | events claimed per relay tick |
| `MAX_ATTEMPTS` | 20 | attempts before dead-letter (~20-min outage tolerance at 1-min cadence) |
| `RETENTION` | 90 days | processed events purged after this (`outbox-retention`) |
| `DEAD_LETTER_RETENTION` | 30 days | abandoned dead-letters reaped after this |

Relay cadence: `outbox-relay` cron `* * * * *` (every minute). Retention: `outbox-retention` cron
`15 3 * * *` (nightly). Both dormant until Inngest is provisioned.

## See also

- `runbooks/dead-letter-recovery.md` — authoritative dead-letter procedure (§A defers to it).
- `runbooks/inngest-provisioning.md` — authoritative worker provisioning + four-step verify (§C).
- `runbooks/credential-disabled-operations.md` — the disabled-seam pilot posture; §1 lists every
  on-demand platform task and its cron wrapper.
- `runbooks/incident-response.md` — severity ladder + escalation if recovery stalls.
