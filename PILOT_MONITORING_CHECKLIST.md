# Pilot Monitoring Checklist — DAILY & WEEKLY

> **Audience:** the operator (founder) running the IdaraWorks controlled pilot on
> `https://idaraworks.vercel.app`.
> **Premise:** a founder-onboarded, **no-real-payment** pilot with 1–2 arm's-length GCC industrial
> SMBs. The production baseline is **exactly** `[Alpha Marine, TESTING]` plus the one pilot org you
> onboard. The credential seams (Inngest, Sentry, Upstash, email, PDF, billing/e-invoice, AI) ship
> **disabled by default** — this is the intended pilot posture, documented in
> [`runbooks/credential-disabled-operations.md`](../../runbooks/credential-disabled-operations.md).
> **This checklist is entirely read-only monitoring.** Nothing here creates an org/user/invitation,
> activates payments/D1, or writes tenant data. Every remediation defers to a runbook.

This is not a replacement for the runbooks — it is the **cadence layer** that tells you *what to look
at, how often, what "good" looks like, and which runbook to open when it isn't good.* It reuses the
existing `runbooks/*` and `docs/pilot/*`; it does not duplicate their procedures.

---

## 0. What you need (access, once)

| Thing | Why | Where |
| --- | --- | --- |
| The app URL | Every health/smoke check | `https://idaraworks.vercel.app` |
| Vercel project console (owner login) | Read structured logs; this is the **manual Sentry** during the pilot | Vercel → project `idaraworks` → Logs |
| A checkout of the repo with `.env.local` present | Run `pnpm smoke:prod`, `pnpm tsx` tooling, and cross-tenant read-only SQL over `DIRECT_URL` | your machine / CI only |
| The expected deployed commit | The commit-match assertion | **pilot baseline = `97985e1`**; update it in release notes on every deploy |
| Baseline org UUIDs | Cleanup/subscription checks | Alpha Marine `d22b2098-2e09-436d-ab9e-ee26c8719cd5`, TESTING `9fcaa697-becd-41ec-97d4-6ce2851ead36` |

**Secret handling:** you never type, print, or store a secret value to run any of this. All secrets
live only in the Vercel encrypted env (runtime) or your local `.env.local` (tooling) — see
[`runbooks/secret-rotation.md`](../../runbooks/secret-rotation.md). `DIRECT_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are **deliberately not deployed to prod** — cross-tenant SQL below runs
from an operator machine with `.env.local`, never from the app runtime.

**Cross-tenant reads are routine, not break-glass.** RLS scopes every in-app read to one org, so a
fleet-wide question (all orgs' subscription state, all open impersonation sessions, the whole
`sign_in_log`) needs a `DIRECT_URL` session. Open it **read-only** and it is an ordinary audit read,
not a break-glass write:

```bash
psql "$DIRECT_URL" -c 'begin transaction read only;' -f your-read-only-query.sql
```

(A break-glass *write* is a different, two-party-approved thing —
[`runbooks/break-glass.md`](../../runbooks/break-glass.md).)

---

## 1. The degraded-alarm context (read this first)

Because Inngest, Sentry, and Upstash are unprovisioned, **the automatic paging channels are OFF.**
Monitoring during the pilot is therefore **operator-pull**, not alert-push. Know exactly what you are
substituting for:

| Missing seam | What it would have done automatically | Your manual equivalent (this checklist) |
| --- | --- | --- |
| **Sentry** (`SENTRY_DSN` unset) | Aggregate + page on unhandled errors, worker failures, `outbox_dead_letter`, rollup/storage drift | **Read Vercel logs (ERROR)** on a cadence + watch `/api/health`. `beforeSend` PII scrub is moot while off. |
| **Inngest** (`INNGEST_*` unset) | Run the outbox relay + 5 crons (dead-letter alarm, retention, exception nightly, subscription lifecycle, retention-prune) | Crons are **dormant → run the equivalent function on-demand** ([`credential-disabled-operations.md §1`](../../runbooks/credential-disabled-operations.md)). Reconciliation/drift checks below are **manual runs**, not passive alarms. |
| **Upstash** (`UPSTASH_*` unset) | Global, durable rate limits | In-memory limiter — **per-instance, resets on deploy**. Watch the public `share`/`webhook`/`health`/`login` surfaces for abuse in logs. Adequate for a controlled pilot; must be Upstash-backed before adversarial exposure. |

Consequence for this doc: **`/api/health` and the Vercel ERROR log are your two primary signals.**
Everything else corroborates them.

---

## 2. Severity & escalation ladder (compact)

Full detail: [`runbooks/incident-response.md`](../../runbooks/incident-response.md) §3. Declare from the
**worst plausible** reading, record the UTC time, downgrade only on evidence.

| Sev | Trigger (pilot-relevant) | First move | Owner |
| --- | --- | --- | --- |
| **SEV-1** | Cross-org data visible/writable (tenancy), data loss/corruption, sustained `/api/health` 503 | **Contain first** — pause prod traffic, preserve evidence, **page the owner** | `abdullaalojan@gmail.com` |
| **SEV-2** | A core flow broken for all orgs (login/org-load/upload/approval), **dead-letters accumulating**, **rollup/storage drift alarm firing** | Same-day; roll back if deploy-linked ([`deployment-and-rollback.md`](../../runbooks/deployment-and-rollback.md)) | notify owner |
| **SEV-3** | Degraded with a workaround; single-org, non-isolation | Ticket; next working day | — |

Correlate before acting: grab the `request_id` from the user's error digest or the `x-request-id`
response header, filter **Vercel → Logs** to it (`request_id`/`org_id`/`user_id`-tagged; no tenant
business values at info+), and confirm the failing dependency in `/api/health`.

---

## 3. DAILY checklist

Fast, mostly one command. Target: 5 minutes. Skip nothing that reads `/api/health` — it is the ground
truth for two hard dependencies plus the queue and the config posture.

| # | Check | One-line command / where | Healthy in the pilot | If abnormal |
| --- | --- | --- | --- | --- |
| D1 | Production health | `curl -s .../api/health \| jq '{ok,commit,checks}'` | `ok:true`, HTTP 200 | → D-detail below |
| D2 | Deployed commit matches | `EXPECTED_COMMIT=97985e1 pnpm smoke:prod` (or your last-deployed sha) | `deployed commit matches` PASS | investigate unexpected deploy / rollback |
| D3 | Queue + worker status | `/api/health` → `checks.queue` | `dead_lettered:0`; `unprocessed` may be >0 & climbing | D3 detail |
| D4 | Failed events (dead-letter) | `/api/health` → `checks.queue.dead_lettered` | `0`, `alert:false` | **SEV-2** → D4 detail |
| D5 | Storage health | `/api/health` → `checks.storage` | `ok:true` | **SEV-1/2** → D5 detail |
| D6 | Vercel ERROR-log scan (manual Sentry) | Vercel → Logs, level=Error, last 24h | no unexpected ERROR lines | D6 detail |
| D7 | Unusual login/invitation activity | `sign_in_log` read (D7 query) | no spikes in `login_failure`/`otp`/`invite_*` | D7 detail |
| D8 | Open support-impersonation sessions | `impersonation_session` read (D8 query) | none open unexpectedly (`ended_at IS NULL`) | D8 detail |

### D1 — Production health

```bash
curl -s https://idaraworks.vercel.app/api/health | jq '{ok, commit, checks}'
```

Healthy pilot report (`src/platform/observability/health.ts`):

```json
{
  "ok": true,
  "commit": "97985e1…",
  "checks": {
    "db":      { "ok": true,  "latency_ms": 12 },
    "storage": { "ok": true,  "latency_ms": 40 },
    "queue":   { "ok": true,  "unprocessed": 0, "oldest_unprocessed_age_s": 0, "dead_lettered": 0, "alert": false },
    "inngest": { "configured": false, "status": "unconfigured", "detail": "INNGEST_… not provisioned …" }
  }
}
```

- **`db` / `storage`** are the only two that gate HTTP status. `ok:false` on either → **HTTP 503 →
  SEV-1/2**, page owner, open `incident-response.md`. `/api/ready` still 200 distinguishes "our
  process is up, a dependency is down" from "our process crashed."
- **`inngest.status:"unconfigured"`** is **healthy** in the pilot — it is the documented
  pre-provisioning state, never a gate. If it ever reads `configured` unexpectedly, someone
  provisioned Inngest — expected only after OA-4 (`inngest-provisioning.md`).
- **`latency_ms`** is your cheap DB/storage-latency gauge (feeds W2 / W6). A sudden 5-10× jump is an
  early degradation signal.
- The route is rate-limited and 5s-cached, so rapid repeats return the same snapshot — that's fine.

### D3 — Queue + worker status

`checks.queue` gauges come from `app.outbox_stats(20)`. **Pilot nuance (important):** with Inngest
dormant the relay never claims, so:
- `unprocessed` **climbs** as events are written and durably queued — **this is expected, not an
  incident** ([`queue-worker-recovery.md`](../../runbooks/queue-worker-recovery.md) pilot note).
- `attempts` only bump when the relay runs, so `dead_lettered` **stays 0** in pure dormant state. A
  non-zero `dead_lettered` means the relay was run on-demand against an unreachable Inngest (or a real
  consumer/poison fault) → D4.
- Watch the **trend** of `unprocessed` day-over-day (jot it down). A steadily growing backlog is fine
  short-term but is the signal that you should either provision Inngest or drain on-demand (W-note).

### D4 — Failed events (dead-letter)

```bash
curl -s https://idaraworks.vercel.app/api/health | jq '.checks.queue.dead_lettered, .checks.queue.alert'
```

Healthy: `0`, `false`. **`dead_lettered > 0` → `alert:true` → SEV-2.** Because Sentry is off, the
health gauge + the Vercel ERROR line `domain_event dead-letter — events exceeded max attempts`
(`{id,name,attempts}` sample) are your **only** signal — there is no page.
**Do not redrive yet.** Follow [`runbooks/dead-letter-recovery.md`](../../runbooks/dead-letter-recovery.md):
diagnose → classify `last_error` (transport / consumer-bug / poison) → fix+deploy if needed →
`pnpm tsx tooling/scripts/redrive-dead-letters.ts` → verify `dead_lettered` returns to 0. Inspect rows
read-only over `DIRECT_URL`:

```sql
select id, org_id, name, version, attempts, last_error, occurred_at
from public.domain_event
where processed_at is null and attempts >= 20
order by occurred_at;
```

### D5 — Storage health

`checks.storage.ok` is one authenticated `ListObjectsV2` on `tenant-media` — it proves endpoint +
S3 credential + bucket in one shot. `ok:false` → **503 → SEV-1/2**. If not deploy-linked it is a
hosted-storage/credential incident: check the storage provider console; rotate storage keys per
[`secret-rotation.md`](../../runbooks/secret-rotation.md) if a credential is suspected (storage keys
are storage-scoped and **cannot touch the DB**). Deeper leak/orphan check is weekly (W3).

### D6 — Vercel ERROR-log scan (the manual Sentry pass)

Vercel → project `idaraworks` → Logs → filter **Error**, last 24h. This is the pilot substitute for
Sentry aggregation. Scan for these known page-worthy lines (each maps to a runbook):

| ERROR line | Meaning | Route to |
| --- | --- | --- |
| `domain_event dead-letter — events exceeded max attempts` | Poison/blocked event | D4 / dead-letter-recovery |
| `cost rollup drift detected — cache differed from recompute (missed invalidation)` | A tenant may have seen a wrong margin/cost | **SEV-2** → W3 / incident-response §2 |
| `storage reconcile … orphanKeys > 0` | Bucket object with no owning DB row (leak-shaped) | **SEV-2** → W3 |
| `worker handler failed` `{worker,org_id,request_id,run_id}` | A worker threw (only if Inngest live) | queue-worker-recovery §C |
| `unhandled request error` | Server error for a user request | correlate by `request_id`; triage |
| `upstash rate limit unavailable` | Only if Upstash configured-and-failing (n/a while unset) | note; capacity |

An empty/expected error log is the healthy state. Any unexpected recurring line → declare severity
from the table in §2.

### D7 — Unusual login / invitation activity

`sign_in_log` (`0003_identity.sql`) is append-only and records `login_success/login_failure/logout/
signup/mfa_*/otp_sent/otp_verified/invite_sent/invite_accepted/membership_deactivated`. Read the last
24h fleet-wide (read-only `DIRECT_URL`):

```sql
select org_id, event, count(*) as n, max(created_at) as last_seen
from public.sign_in_log
where created_at > now() - interval '24 hours'
group by org_id, event
order by n desc;
```

Healthy: a handful of `login_success`, the pilot's own `invite_*`/`otp_*` as you onboard, near-zero
`login_failure`. **Abnormal:** a burst of `login_failure`/`mfa_challenge_failure`/`otp_sent` (credential
stuffing / OTP pumping — remember Upstash is off, so limits are per-instance), or an `invite_sent` you
didn't originate. Investigate the source `ip`/`user_agent` columns; if it looks like abuse, treat as a
security event (incident-response §2) and prioritise provisioning Upstash. **You never create or send
an invitation from this checklist** — you only observe the log.

### D8 — Open support-impersonation sessions

Any IdaraWorks-staff entry into a tenant org is dual-logged and time-bounded. A **currently open**
session (`ended_at IS NULL`) that isn't a support call in progress is a finding. Fleet-wide read-only:

```sql
select org_id, staff_user_id, reason, break_glass, started_at, now() - started_at as open_for
from public.impersonation_session
where ended_at is null
order by started_at;
```

Healthy: empty, or one short-lived session you know about. **Abnormal:** a long-lived open session →
close it via the governed path (`endImpersonation(<id>)` — dual-logged; do **not** hand-update the row)
per [`impersonation-history.md`](../../runbooks/impersonation-history.md) §5. Full consent/break-glass
review is weekly (W8).

---

## 4. WEEKLY checklist

Deeper, periodic. Target: 20-30 minutes. These are the checks that a cron would run automatically if
Inngest were provisioned — during the pilot **you run them**.

| # | Check | Command / where | Healthy | If abnormal |
| --- | --- | --- | --- | --- |
| W1 | Full prod smoke (18/18) + commit | `EXPECTED_COMMIT=<sha> pnpm smoke:prod` | all checks PASS | W1 detail |
| W2 | Database health | `/api/health` latency + migration ledger + backup posture | latency steady; migrations `0000–0064`; backups green | W2 detail |
| W3 | Reconciliation failures (rollup / storage / subscription) | on-demand runs (crons dormant) | 0 drift, 0 orphans, 0 recon findings | **SEV-2** → W3 detail |
| W4 | Subscription state | `org_plan_state` read (W4 query) | pilot org `internal_pilot`/`trialing`, `provider` null; prices placeholder | W4 detail |
| W5 | Cleanup residue / baseline | `pnpm tsx tooling/scripts/s7-inventory.ts` | exactly `[Alpha Marine, TESTING]` + pilot org; S7 counters 0 | W5 detail |
| W6 | Slow operations (perf budgets) | Vercel durations + health `latency_ms` vs §11 budgets | p95 under budget | W6 detail |
| W7 | Unusual exports | Vercel logs `GET …/export` | only expected, privileged exporters | W7 detail |
| W8 | Support-impersonation history | `impersonation_session` review (W8 queries) | every break-glass noticed; no stale/off-boarded staff | W8 detail |
| W9 | Audit-log review | `audit_log` spot-read / export | sensitive actions attributable; append-only intact | W9 detail |

### W1 — Full production smoke

```bash
# bash
EXPECTED_COMMIT=$(git rev-parse HEAD) pnpm smoke:prod
# PowerShell
$env:EXPECTED_COMMIT = (git rev-parse HEAD); pnpm smoke:prod
```

Read-only, no auth, no test data (`tooling/scripts/smoke-prod.ts`). Asserts the auth gate + return
path, the security headers (CSP `default-src 'self'`, CSP pins the Supabase host, HSTS, nosniff,
`x-request-id` echoed, `x-powered-by` absent), readiness, every `/api/health` dependency, **`queue has
no dead-letters`**, **`health inngest explicit`**, and **`deployed commit matches`** when
`EXPECTED_COMMIT` is set. **Any FAIL → investigate before anything else.** A commit mismatch means the
alias points at an unexpected build → confirm/rollback per `deployment-and-rollback.md`. A missing
security header is a config regression → SEV-2.

### W2 — Database health

- **Latency trend:** compare this week's `checks.db.latency_ms` / `checks.storage.latency_ms` band to
  last week's. Co-located Seoul DB is normally low-tens-of-ms; a sustained climb precedes trouble.
- **Migration ledger:** the deployed schema is migrations **`0000–0064`** (next is `0065`). Confirm no
  unexpected/partial migration — `pnpm db:migrate` is idempotent and records applied filenames; a clean
  run reports nothing new to apply.
- **Backups (owner-provisioned, verify posture):** confirm PITR / nightly logical / bucket replication
  per [`backup-monitoring.md`](../../runbooks/backup-monitoring.md). The automated backup-status monitor
  is itself a credential-gated seam — until it's wired, this is a **manual weekly console check**. The
  first **restore drill** (RPO ≤ 1h / RTO ≤ 4h) must be run with evidence filed before go-live
  ([`restore-drill.md`](../../runbooks/restore-drill.md); launch-criteria §D).

### W3 — Reconciliation failures (the drift alarms)

All three reconcilers are **dormant crons** in the pilot, so you run them on-demand and read the
result. Each is a platform task (no tenant context) — run from a machine with `.env.local`.

1. **Cost-rollup drift** (`reconcileOrgRollups`, `src/modules/costing/service.ts`) — recomputes each
   active job's cached rollup from source; **drift = a missed cache invalidation → a tenant may have
   seen a wrong margin/cost.** Healthy result: `drifted: 0`. Non-zero, or the ERROR line
   `cost rollup drift detected …`, is **page-worthy → SEV-2** (incident-response §2). Normally driven
   by the exception nightly; invoke on-demand per `credential-disabled-operations.md §1`.
2. **Storage reconcile** (`reconcileAllOrgs`, `src/workers/functions/storage-reconcile.ts`) — diffs
   the bucket listing against DB-known paths. Healthy: `orphanKeys: 0`, `drift:false`. `orphanKeys > 0`
   (ERROR `storage reconcile`) = an object with no owning row (bypassed upload / failed-cleanup
   original) → **SEV-2**, leak-shaped; preserve and investigate.
3. **Subscription reconciliation** (`runReconciliation`, `subscription-worker.ts`) — compares local
   billing state to the provider's view and **records drift, never overwrites**. In the pilot the
   billing provider is **disabled** and pilot orgs have `provider=null`, so this scan should find
   **nothing** (`findings: 0`) — every org is skipped for want of a `provider_customer_id`. Any
   `reconciliation` row here would itself be anomalous (residue or an unexpected provider linkage) →
   investigate; residue is handled by `s9-residue-purge.ts` (see W5 / data-cleanup).

### W4 — Subscription state

Pilot orgs must sit in a non-paying, provider-less state. Read `org_plan_state` fleet-wide
(read-only `DIRECT_URL`):

```sql
select o.name, s.billing_state, s.plan_key, s.provider,
       s.provider_customer_id, s.trial_end, s.grace_until, s.suspend_at, s.purge_at, s.legal_hold
from public.org_plan_state s join public.org o on o.id = s.org_id
order by o.created_at;
```

Healthy: the pilot org (and Alpha Marine / TESTING) in **`internal_pilot`** or **`trialing`**, `plan`
`growth`, **`provider` null**, no `*_at` deadlines pushing it toward suspension.
**Abnormal / act:**
- A pilot org drifting into a **read-only** state — `suspended`/`cancelled`/`purge_pending`/`purged`
  (`READ_ONLY_BILLING_STATES`) — should **not** happen for `internal_pilot` (no trial deadline). If it
  does, something advanced state; investigate before the tenant loses ADD. Reads/exports are never
  blocked, only mutations (FR-9). See [`05-operational-billing-readiness.md`](05-operational-billing-readiness.md) §5-6.
- A **non-null `provider`** or a `provider_customer_id` on a pilot org — nobody should have wired a
  merchant; D1 is closed. Investigate.
- **`plan_price` still `is_placeholder=true`** and no real price IDs loaded — that is the correct
  no-payment posture; confirm it hasn't been flipped.
- **`legal_hold=true`** unexpectedly — a hold refuses all purge; know why it's set.

Billing state is only ever changed through the platform path (`app.advance_subscription`,
`assert_platform_task`-guarded) — **never a tenant action, and never yours from this checklist.**

### W5 — Cleanup residue / baseline

```bash
pnpm tsx tooling/scripts/s7-inventory.ts   # READ-ONLY
```

Healthy pilot output: **exactly three orgs** — `[PROTECTED] Alpha Marine`, `[PROTECTED] TESTING`, and
your one pilot org (tagged `synthetic` only because it isn't in the hard-coded protected set — that's
fine; it is your real pilot tenant). The S7 counters (`digest`, `ai_interaction`, `customer_update`,
`share_token`, and exceptions carrying S7 rule keys) should be at the levels the pilot org legitimately
produced — **not** the leftover of a demo org. **Abnormal:** any *extra* `[synthetic]` org (a demo/test
org that leaked, e.g. `S7 Org`, `PERF`, `S6 Org`) → it is cleanup residue. Follow
[`data-cleanup.md`](../../runbooks/data-cleanup.md): **inventory → dry-run (`s7-cleanup.ts`) → confirm
the delete set → owner-approved `--apply`**. The destructive `--apply` is auto-classifier-gated and
**owner-run** — do not attempt it from an automated context. Protected orgs are excluded by **name AND
UUID**; if you add your pilot org to the permanent baseline later, add its name+UUID to
`PROTECTED_NAMES`/`PROTECTED_IDS` first.

> If you have introduced the pilot org as a *permanent* production tenant, add it to the protected sets
> so future cleanup never targets it — otherwise it will keep showing as `synthetic` here (harmless for
> a read-only inventory, but a hazard if a cleanup `--apply` is ever run).

### W6 — Slow operations (perf budgets)

The §11 co-located budgets (BUILD_BIBLE §13.7): **Today compose p95 < 1500 ms**, **job costing read
p95 < 1500 ms** (cached-rollup path), **report-submit round-trip < 10 s** (incl. one photo on 3G),
**nightly evaluation + reconcile < 5 min/org**. Because Sentry (and any APM) is off, read real p95
from **Vercel function duration** metrics for the relevant routes plus the `/api/health` `latency_ms`
band. Healthy: comfortably under budget at pilot volume. **Do not run `pnpm perf` against production** —
it seeds a throwaway org and would pollute the W5 baseline; run the perf harness only against a non-prod
DB when you need a load proof. **Abnormal:** a route trending toward budget as the pilot's data grows →
note it, and check the cost-rollup path (a missed invalidation both drifts *and* slows reads — ties to
W3). Sustained budget breach for all orgs is SEV-2-adjacent (core-flow degradation).

### W7 — Unusual exports

Self-service export (`GET /api/o/<orgId>/export?entity=<key>`) is **gated to `data.export` = owner /
admin / accounts**, tenant-scoped, paged, and money-redacted per the caller's privilege
([`exports.md`](../../runbooks/exports.md)). **Known limitation: the export act is NOT audited** — it's
a pure read, writes no `audit_log` row. So accountability lives at the infra layer: Vercel → Logs,
filter path `…/export`, review who pulled what. Healthy: only your privileged pilot users, at plausible
frequency. **Abnormal:** a burst of exports, an export by an unexpected principal, or exports of every
entity in rapid succession (bulk exfil shape) → correlate the `request_id`/`org_id`/`user_id` tags,
confirm the actor legitimately holds `data.export`, and treat unexplained bulk export as a security
event (incident-response §2).

### W8 — Support-impersonation history review

Beyond the daily open-session check (D8), review the week's sessions
([`impersonation-history.md`](../../runbooks/impersonation-history.md) §3-4), read-only `DIRECT_URL`:

```sql
-- Every break-glass (consent-skipped) session — each owes the tenant a post-hoc notice.
select org_id, staff_user_id, reason, started_at, ended_at
from public.impersonation_session
where break_glass = true and started_at > now() - interval '7 days'
order by started_at desc;
```

Review checklist: every `break_glass=true` session has a **recorded tenant notification** (the notice
is a human/legal step; the app records the session, not the notice — send it if missing, within the
applicable UAE/KSA PDPL window from `started_at`); no session lingered open; every `staff_user_id` is
still an **active** `platform_staff` row (a session by an off-boarded operator is a process gap →
[`access-revocation.md`](../../runbooks/access-revocation.md) §3); every `reason` is meaningful.
**Prove the dual-log fired** (the DoD): the same sessions appear as tenant-visible `audit_log` rows —

```sql
select org_id, action, summary, actor_user_id, created_at
from public.audit_log
where action in ('support.impersonation_started','support.impersonation_ended')
  and created_at > now() - interval '7 days'
order by created_at desc;
```

### W9 — Audit-log review

`audit_log` (`0006_audit_activity.sql`) is the **append-only** security/config/financial-mutation trail
— RLS org-scoped, `grant select, insert` only, `revoke update, delete` (the trail cannot be rewritten),
and **never pruned** (≥6-yr financial floor, `retention.md`). Weekly, spot-review the pilot org's
sensitive actions. Tenant-scoped, no DB creds needed — self-serve export:

```
GET /api/o/<pilot-org-uuid>/export?entity=audit_log     # as an owner/admin/accounts session
```

or fleet-wide read-only over `DIRECT_URL`:

```sql
select action, count(*) as n, max(created_at) as last_seen
from public.audit_log
where org_id = '<pilot-org-uuid>' and created_at > now() - interval '7 days'
group by action order by n desc;
```

Healthy: actions are attributable to real actors and match real activity — membership changes,
approvals, invoice issuance, credit notes, config revisions, `billing.dunning_reminder` (only if
lifecycle ran), `support.impersonation_*`. **Abnormal:** a sensitive action (`membership.deactivate`,
config change, financial mutation) with no corresponding real-world event, or an actor who shouldn't
have that permission → investigate the `request_id` in Vercel logs. Confirm append-only integrity holds
(no gaps you can explain only by deletion — deletion is not grantable, so a "missing" row means it was
never written, i.e. a code path bypassed `command()`, itself a finding).

---

## 5. Quick command reference

```bash
# Health (D1, D3, D4, D5) — the one you run most
curl -s https://idaraworks.vercel.app/api/health | jq '{ok, commit, checks}'

# Readiness (dependency-free liveness — distinguishes crash vs dependency-down)
curl -s https://idaraworks.vercel.app/api/ready

# Full read-only prod smoke + commit assertion (D2, W1)
EXPECTED_COMMIT=$(git rev-parse HEAD) pnpm smoke:prod          # bash
$env:EXPECTED_COMMIT = (git rev-parse HEAD); pnpm smoke:prod   # PowerShell

# Baseline inventory — read-only (W5)
pnpm tsx tooling/scripts/s7-inventory.ts

# Dead-letter redrive — ONLY after root cause fixed+deployed (D4)
pnpm tsx tooling/scripts/redrive-dead-letters.ts

# Cross-tenant read-only SQL session (D7, D8, W3-subscription, W4, W8, W9)
psql "$DIRECT_URL" -c 'begin transaction read only;'   # then run the SELECTs above
```

---

## 6. Cross-references

| Topic | Runbook / doc |
| --- | --- |
| Disabled-seam pilot posture (what's degraded + manual equivalents) | [`runbooks/credential-disabled-operations.md`](../../runbooks/credential-disabled-operations.md) |
| Queue + worker recovery (outbox, Inngest, backlog) | [`runbooks/queue-worker-recovery.md`](../../runbooks/queue-worker-recovery.md) |
| Dead-letter diagnose → redrive | [`runbooks/dead-letter-recovery.md`](../../runbooks/dead-letter-recovery.md) |
| Incident severity, triage, escalation | [`runbooks/incident-response.md`](../../runbooks/incident-response.md) |
| Deploy / rollback / commit verification | [`runbooks/deployment-and-rollback.md`](../../runbooks/deployment-and-rollback.md) |
| Synthetic-data cleanup (residue → baseline) | [`runbooks/data-cleanup.md`](../../runbooks/data-cleanup.md) |
| Self-service export (unusual-export review) | [`runbooks/exports.md`](../../runbooks/exports.md) |
| Support-impersonation history & audit | [`runbooks/impersonation-history.md`](../../runbooks/impersonation-history.md) |
| Retention windows / financial floor | [`runbooks/retention.md`](../../runbooks/retention.md) |
| Backup posture / restore drill | [`runbooks/backup-monitoring.md`](../../runbooks/backup-monitoring.md) · [`runbooks/restore-drill.md`](../../runbooks/restore-drill.md) |
| Owner-provisioning (Inngest / Sentry) | [`runbooks/inngest-provisioning.md`](../../runbooks/inngest-provisioning.md) · [`runbooks/sentry-provisioning.md`](../../runbooks/sentry-provisioning.md) |
| Billing/e-invoice pilot readiness | [`docs/pilot/05-operational-billing-readiness.md`](05-operational-billing-readiness.md) |
| Launch criteria (pre-pilot green state) | [`docs/pilot/06-launch-criteria-checklist.md`](06-launch-criteria-checklist.md) |
| Remaining owner actions | [`docs/pilot/08-owner-action-checklist.md`](08-owner-action-checklist.md) · [`docs/MVP-READINESS-REPORT.md`](../MVP-READINESS-REPORT.md) |

> **Signals ground truth:** `/api/health` (`src/platform/observability/health.ts`) and the Vercel
> ERROR log. While Inngest/Sentry/Upstash are unprovisioned, monitoring is operator-pull — run this
> checklist on cadence; nothing pages you.
