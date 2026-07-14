# Cancellation → Purge Runbook (S9 subscription lifecycle)

**What this covers:** executing and monitoring an org's subscription **cancellation → read-only →
purge** lifecycle, and the guarantees at each stage. All transitions are driven by the DB sole-writer
`app.advance_subscription` (`assert_platform_task`-guarded); a tenant can never flip its own billing
state. `purged` is terminal; a **legal hold refuses purge** (`runbooks/legal-hold.md`).

## The lifecycle (v1 §13)

```
active ──cancel──▶ cancelled ──(read-only export window)──▶ purge_pending ──(warnings)──▶ purged
```

- **cancelled** — the org enters a **read-only** billing state. Per **FR-9**, read-only blocks ADDs
  (create jobs/reports/uploads/etc.) but **NEVER blocks reads or exports** — the org can still export
  all its data during the window. Window default ~60 days (env-configurable
  `LIFECYCLE_WINDOWS.readonlyDays`).
- **purge_pending** — after the read-only window elapses, the deadline sweep schedules purge with a
  short lead (`LIFECYCLE_WINDOWS.purgeWarnDays`, ~7 days) before the terminal delete. NOTE: the
  cancellation path does **not** emit purge-warning notifications or write `dunning_attempt` rows —
  those belong only to the *payment-failure* ladder (past_due/grace), which cancellation never passes
  through. The pre-purge guarantee is the read-only **export window**, not a notification. (If purge-
  warning emails are wanted, they are a future build; do not rely on them today.)
- **purged** — terminal. Data is deleted per the closure/purge pipeline (see the recycle-bin/closure
  walkthrough). `legal_hold` set → `advance_subscription` **refuses** the transition.

## Trigger a cancellation

Cancellation normally originates from the customer (owner-only `billing.manage` action:
`cancelSubscriptionAction` → `cancelSubscription`) or from a provider `canceled` webhook. To drive it
operationally (platform):

```sql
-- move an org to cancelled (read-only export window opens)
select app.advance_subscription('<org-uuid>'::uuid, 'cancelled');
```

The customer-facing path sets `cancel_at_period_end` so the state flips at period end; the subscription
settings page shows the pending cancellation.

## Monitor the window and purge

The **lifecycle sweep** (`sweepLifecycle` in `src/workers/functions/subscription-worker.ts`) walks the
deadlines nightly (dormant in prod until Inngest; run on demand meanwhile):

```bash
pnpm tsx -e "import('./src/workers/functions/subscription-worker').then(m=>m.sweepLifecycle(Date.now())).then(r=>{console.log(r);process.exit(0)})"
```

It: expires the read-only window → `purge_pending`, records the warning dunning attempts, and (when the
purge deadline passes and no legal hold) advances toward `purged`.

## Verify each stage

1. **cancelled (read-only):** an ADD is rejected (`BillingReadOnlyError`), a read/export still works:
   ```sql
   select billing_state, purge_at, legal_hold from public.org_plan_state where org_id = '<org>';
   ```
2. **Export window honoured:** the customer can run the self-service export (`runbooks/exports.md`)
   throughout `cancelled`.
3. **purge_pending:** `purge_at` is set with the ~7-day lead; `public.dunning_attempt` stays EMPTY for
   a cancellation (dunning rows are written only for the payment-failure ladder — do not expect them).
4. **purged:** terminal; a subsequent `advance_subscription` on a purged org raises
   ("is purged (terminal), cannot transition").
5. **Legal hold blocks purge:** if `legal_hold = true`, the purge transition raises — resolve the hold
   first (`runbooks/legal-hold.md`).

## Guarantees

- **Never lose data silently:** the read-only window guarantees an export opportunity before purge.
- **No accidental purge:** the sole-writer + `assert_platform_task` + the legal-hold guard mean purge
  only happens on an elapsed deadline for a non-held org.
- **FR-9:** reads/exports are never blocked by any read-only billing state.

## Owner actions

- **[OWNER ACTION]** Inngest keys to make the sweep run nightly (until then, run it on demand at close).
- **[OWNER ACTION]** If purge-warning emails to the customer are desired before the terminal delete,
  they are a future build (they'd ride the existing disabled notification seam). Today the guarantee is
  the read-only export window; the state transitions themselves are audited to the tenant's own log.
