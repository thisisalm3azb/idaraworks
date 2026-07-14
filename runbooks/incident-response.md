# Incident Response (doc 10 #50; BUILD_BIBLE §15.7)

**Lifecycle: detect → triage/severity → contain → scope per-tenant → notify → remediate → post-mortem.**
This supersedes the Phase-I stub. It is the full, tabletop-tested version required
for pilot readiness (S11). The scenario in [§9 Tabletop exercise](#9-tabletop-exercise)
must be walked end-to-end, with an evidence-log entry recorded, **before pilot start**.

Sibling runbooks this one hands off to:
[deployment-and-rollback.md](deployment-and-rollback.md) ·
[dead-letter-recovery.md](dead-letter-recovery.md) ·
[secret-rotation.md](secret-rotation.md) ·
[restore-drill.md](restore-drill.md) ·
[inngest-provisioning.md](inngest-provisioning.md) ·
[sentry-provisioning.md](sentry-provisioning.md)

Why tenant scope is a first-class step here and not an afterthought: IdaraWorks is
**flat multi-tenant** — every tenant table carries its own `org_id`, isolation is
enforced by Postgres RLS keyed on transaction-local GUCs set in `withCtx`
(`app.org_id` / `app.user_id` / `app.cost_priv`, see `src/platform/tenancy/withCtx.ts`),
and `app_user` is `NOBYPASSRLS` with **no delete grants**. So **blast radius is
per-org by construction** and every incident has a "which orgs?" answer that must be
established from evidence before anyone is told anything.

---

## 1. Roles for an active incident

| Role | Who | Owns |
| --- | --- | --- |
| **Incident Commander (IC)** | On-call engineer (owner is IC by default pre-team) | Declares severity, drives the flow, holds the timeline |
| **Owner / Legal decision-maker** | Product owner (`abdullaalojan@gmail.com`) | Notification decision + exact regulatory window, break-glass approval, any tenant-facing message |
| **Scribe** | IC if solo | The UTC timeline + evidence log (§10 template) |

Solo operator is the expected pilot-stage reality: the IC wears all hats but still
**writes the timeline as they go** — it is the post-mortem spine and the notification
clock evidence.

---

## 2. Detect — alert sources and the exact signal each emits

Every source below is real and wired unless marked **OWNER ACTION** (provisioning
gap). The `alert:true` / ERROR-log / Sentry columns are the page-worthy channel
(Bible §15.4).

| Source | Where to look | Signal that fires | Page-worthy? |
| --- | --- | --- | --- |
| **`/api/health` — db** | `GET https://idaraworks.vercel.app/api/health` → `checks.db` | `ok:false` → whole report `ok:false` → **HTTP 503**. `db` is a hard dependency (`src/platform/observability/health.ts`). | Yes (outage) |
| **`/api/health` — storage** | same → `checks.storage` | `ok:false` → **HTTP 503**. One authenticated `ListObjectsV2` on `tenant-media` proves endpoint + S3 credential + bucket. | Yes (outage) |
| **`/api/health` — queue** | same → `checks.queue` | `dead_lettered > 0` sets `alert:true` (does **not** 503 — app keeps serving while the bus drains). Also surfaces `unprocessed`, `oldest_unprocessed_age_s`. Gauges come from `app.outbox_stats(MAX_ATTEMPTS)`. | Yes (dead-letters) |
| **`/api/health` — inngest** | same → `checks.inngest` | `status:"unconfigured"` is the documented pre-provisioning state (never a gate). If prod shows this **after** OA-4, the queue relay is silently not delivering. | Config, investigate |
| **Queue dead-letter alarm** | Vercel logs (ERROR) + Sentry | ERROR line `domain_event dead-letter — events exceeded max attempts` with `{id,name,attempts}` sample, from `relay.ts::checkDeadLetters`; Sentry event `outbox_dead_letter` via `captureDeadLetter`. | Yes |
| **Rollup drift alarm** | Vercel logs (ERROR) + Sentry | ERROR line `cost rollup drift detected — cache differed from recompute (missed invalidation)` from `src/modules/costing/service.ts::reconcileOrgRollups`, run nightly by the exception engine. A cached cost rollup disagreed with a from-source recompute → a missed invalidation, i.e. a tenant may have seen a wrong margin/cost. | Yes |
| **Storage-reconcile drift** | Vercel logs (ERROR) | ERROR line `storage reconcile` with `orphanKeys > 0` from `src/workers/functions/storage-reconcile.ts` (nightly cron `0 2 * * *` UTC). An orphan = a bucket object with no owning DB row (a bypassed direct upload or failed-cleanup original). | Yes (leak-shaped) |
| **Tenancy canary** | see note below | Any cross-org read where an org's `withCtx` sees another org's rows. This is the SEV-1 trigger. | Yes — SEV-1 |
| **Sentry** (OWNER ACTION OA-4) | Sentry project, once `SENTRY_DSN` provisioned | Unhandled errors tagged `request_id`; worker failures tagged `worker` / `org_id`. Until provisioned, `/api/health` `inngest` and Vercel ERROR logs are the only alarm channel. See [sentry-provisioning.md](sentry-provisioning.md). | Yes |
| **User report** | Support inbox | The error page shows a **digest**; every response carries `x-request-id`. Either id finds the exact `unhandled request error` log line in Vercel. | Triage |

**Tenancy canary — current status (be honest about this).** The definitive isolation
proof is the **two-org bleed harness** (`tests/integration/bleed-harness.test.ts`):
it seeds every `org_id`-bearing table in Org A **and** Org B under the *same* user,
then asserts Org A's `withCtx` sees zero foreign rows and >0 own rows in every table,
and a registry-completeness guard fails CI if any org-scoped table lacks a seeder. It
runs in the `integration` CI job and **gates every deploy** ([deployment-and-rollback.md](deployment-and-rollback.md)
preconditions). There is **not yet a scheduled production canary** re-running that
probe against live prod on a timer.

> **OWNER ACTION (pre-pilot):** stand up a periodic production tenancy canary — a
> scheduled job (Inngest cron alongside the nightly reconcilers, or an external
> monitor hitting a dedicated read-only probe) that runs the two-org isolation
> assertion against a pair of dedicated canary orgs and pages on any foreign-row
> read. Until it exists, treat the CI bleed harness on deploy + the RLS design as the
> isolation guarantee, and any *field* report of cross-org visibility as an
> immediate SEV-1 (§3).

Fast triage probes (read-only, safe to run anytime):

```bash
# Git-Bash / Linux
curl -s https://idaraworks.vercel.app/api/health | jq '{ok, commit, checks}'
curl -s https://idaraworks.vercel.app/api/ready        # dependency-free liveness
EXPECTED_COMMIT=$(git rev-parse HEAD) pnpm smoke:prod   # full read-only prod smoke
```

```powershell
# PowerShell
Invoke-RestMethod https://idaraworks.vercel.app/api/health | ConvertTo-Json -Depth 6
$env:EXPECTED_COMMIT = (git rev-parse HEAD); pnpm smoke:prod
```

---

## 3. Triage & severity

Declare severity from the **worst plausible** interpretation of the signal, then
downgrade only once evidence rules the worse case out. Record the declaration time
(UTC) — for SEV-1 this timestamp is the notification-clock start (§6).

| Sev | Definition | First move |
| --- | --- | --- |
| **SEV-1** | Tenant-isolation suspicion (cross-org data visible/writable), data loss/corruption, or full outage (`/api/health` 503 sustained) | **Contain first, diagnose second.** Page the owner. Preserve evidence before any cleanup. |
| **SEV-2** | A core flow broken for all orgs (login, org load, uploads, approvals), queue dead-letters accumulating, rollup/storage drift alarm firing | Same-day. Contain via rollback if deploy-linked. |
| **SEV-3** | Degraded behaviour with a workaround; single-org, non-isolation impact | Ticket; next working day. Still gets a timeline if user-facing. |

**Page-worthy signals (Bible §15.4):** tenancy failures, backup/replication failures,
queue dead-letters (`outbox_dead_letter`), rollup/storage drift, sustained error-rate
burn. Everything else is a ticket.

Correlate before you act: pull the `request_id` from the user's digest or the
`x-request-id` response header, filter **Vercel → Project → Logs** to that id (every
request-scoped line is tagged `request_id` / `org_id` / `user_id`; **no tenant
business values at info+**), and confirm the failing dependency against
`/api/health`.

---

## 4. Contain

Match the containment to the fault class. Containment precedes diagnosis for SEV-1.

- **App-level fault (bad deploy).** Roll back per [deployment-and-rollback.md](deployment-and-rollback.md):
  `vercel ls idaraworks` → find the previous **Ready/Production** deploy →
  `vercel promote <previous-deployment-url>` → `pnpm smoke:prod` and confirm the
  `commit` in `/api/health` is the intended prior sha. Migrations are **forward-only
  / expand-first**, so app rollback never requires a data rollback.

- **Suspected tenant-isolation fault (SEV-1).** **Pause production traffic** before
  diagnosing: Vercel dashboard → the production deployment → pause / enable
  password protection. **Preserve logs and DB state — do NOT delete, "clean up," or
  redrive anything before evidence is captured.** The RLS + `NOBYPASSRLS` +
  no-delete-grant design means a genuine cross-org read requires a *platform* fault
  (a broken policy, a leaked GUC, a `SECURITY DEFINER` gap), so the offending code
  path and the logs proving it are the entire post-mortem.

- **Queue dead-letters (SEV-2).** The app keeps serving (non-gating). **Do not
  redrive yet** — dead-letters are never auto-redriven and redrive is a *post-fix*
  action. Diagnose root cause per [dead-letter-recovery.md](dead-letter-recovery.md)
  (classify `last_error`: transport → safe once queue is back; consumer bug → fix +
  deploy first; poison payload → treat as a defect, do not redrive).

- **Storage credential suspicion.** Rotate storage keys per
  [secret-rotation.md](secret-rotation.md). Storage keys are storage-scoped and
  **cannot touch the DB** (Bible §5.2 blast-radius note) — a storage compromise does
  not implicate tenant DB rows.

- **Secret leak (key in a chat/log/screenshot/ticket).** Rotate **immediately** in
  the emergency order (service-role → `APP_DB_PASSWORD` → storage → anon →
  Inngest/Sentry) per [secret-rotation.md](secret-rotation.md), then audit
  `sign_in_log` and Supabase auth logs for the exposure window.

- **DB down / storage down (503).** If not deploy-linked, this is likely a hosted
  Supabase or Supavisor incident — check the Supabase status/dashboard (**OWNER**
  has the console). `/api/ready` still returns 200 (process is up) which distinguishes
  "our process crashed" from "our dependency is down."

**Break-glass rule (doc 10 #45).** Any direct production data access during
containment (via `DIRECT_URL` only — never the app runtime) requires **two-party
approval recorded BEFORE access**, and **post-hoc tenant notification where tenant
data was viewed**. Support impersonation is the in-app equivalent: consent- or
break-glass-gated, banner-shown, dual-logged to the tenant audit log
(`src/modules/support/service.ts`, `public.impersonation_session`).

---

## 5. Scope per-tenant (before any external message)

This step runs **before** notification and **before** remediation cleanup. Answer:
*exactly which orgs were affected, and in what UTC window?*

Read-only, via the tooling/migration connection (`DIRECT_URL`) or, for RLS-scoped
reads, an owner/service-role query — never the app runtime:

1. **Which orgs, from evidence:**
   - `audit_log` — mutations by `org_id` in the window (append-only; triggers guard it).
   - `sign_in_log` — who authenticated, from where, when.
   - `domain_event` (`org_id`) — what facts were emitted; for a dead-letter incident
     these are the events that failed to deliver, so the affected orgs are exactly
     `select distinct org_id from public.domain_event where processed_at is null and attempts >= 20`.
   - `impersonation_session` — any staff access to tenant data in the window.
2. **Classify the impact per org:** data-exposure (isolation), data-loss/corruption,
   delayed-effect (undelivered event: e.g. a `file.uploaded` whose derivative never
   generated, an `invoice.issued` whose downstream never ran), or degraded-only.
3. **For an isolation incident specifically:** identify both sides — the org whose
   `withCtx` *saw* foreign data **and** every org whose data was *exposed*. Both are
   affected parties for notification.

Record the org list + window in the evidence log **before** step 6. If the evidence
is ambiguous, scope to the **superset** of possibly-affected orgs; you can narrow
later, you cannot un-tell someone.

---

## 6. Notify (regulatory windows)

**The owner / legal decision-maker owns this step and the exact clock.** IC supplies
the facts (org list, window, what data, containment status); owner decides message
and timing.

- **Clock start = detection time** (the SEV-1 declaration timestamp from §3), recorded
  in UTC in the evidence log.
- **Applicable regimes are PDPL/GDPR-style**, per each affected org's country
  (pilot orgs are UAE `AE` / KSA `SA` — see the org's `country`/`base_currency`). UAE
  PDPL and KSA PDPL both impose breach-notification duties to the regulator and, in
  defined cases, to data subjects, within jurisdiction-specific windows.
  > **OWNER ACTION:** the **exact notification windows and thresholds are an owner /
  > legal determination**, not an engineering constant. Do not hard-code a number
  > here; the owner confirms the current UAE/KSA windows per affected org at incident
  > time. Engineering's job is to make the clock-start and the affected-org set
  > unambiguous so legal can act inside whatever window applies.
- Keep notifications **factual**: what happened, which of *their* data, the window,
  what was done, what they should do. No speculation, no blame, no other org's name.
- Log every notification (org, channel, timestamp, who sent) in the timeline.

---

## 7. Remediate

Only after containment holds and scope is recorded:

- **Deploy the fix** through the normal path ([deployment-and-rollback.md](deployment-and-rollback.md)):
  `pnpm db:migrate` (if a migration is part of the fix — forward-only, expand-first)
  → `pnpm build` → `vercel deploy --prod --yes` → `pnpm smoke:prod` with
  `EXPECTED_COMMIT` asserted.
- **Dead-letters:** *after* the fix is live, redrive via the platform surface —
  `pnpm tsx tooling/scripts/redrive-dead-letters.ts` (resets `attempts` to 0 via
  `app.redrive_dead_lettered_domain_events`; consumers are idempotent by event id so
  duplicate delivery is harmless). Verify `/api/health` → `checks.queue.dead_lettered`
  returns to 0 and `unprocessed` drains within a few relay ticks, and that the
  consumer's effect now exists. Full procedure: [dead-letter-recovery.md](dead-letter-recovery.md).
- **Rollup drift:** the nightly reconcile self-heals the cache on its next run
  (`app.refresh_cost_rollup`); if a tenant saw a wrong figure, that fact goes in the
  scope + notification, not just the code fix.
- **Storage orphans:** an orphan is a *leak-shaped* finding — confirm whether the
  object is a bypassed upload (investigate the upload path) or a failed-cleanup
  original before removing anything; removal of tenant objects is break-glass.
- **Data restore** (loss/corruption): follow [restore-drill.md](restore-drill.md).
  Source is Supabase PITR **(OWNER ACTION: confirm the PITR add-on is active on the
  hosted project — required before pilots)** or the latest daily backup; restore to a
  **plain Postgres 17 target, never production**, verify per-org row counts, then
  reconcile forward. A **second-provider / off-Supabase backup copy** for
  vendor-exit resilience is an **OWNER ACTION** to provision.

Do not close the incident at "fix deployed." Closure is §8.

---

## 8. Post-mortem (blameless)

Within **5 working days** of resolution. Blameless: the artifact interrogates the
*system*, never a person.

Contents:
1. **Timeline (UTC)** — detection → declaration → containment → scope → notification
   → fix → verification. Lifted from the evidence log.
2. **Root cause** — the actual mechanism, to the code path / migration / config.
3. **Blast radius** — the per-org list and window from §5; what data, how many orgs.
4. **What limited it** — which control caught or bounded it (RLS deny, bleed harness,
   `NOBYPASSRLS`, expand-first migrations, dead-letter cap).
5. **What would have caught it earlier** — the missing signal (e.g. "no scheduled prod
   tenancy canary," "Sentry not yet provisioned").
6. **Action items** — each **dated** with a single owner. Isolation/reliability items
   are not "nice-to-have."

**Closing artifact (Bible §15.7): a regression test merged to `main`.** The incident
is **not closed** without it. For an isolation incident that means an assertion added
to the bleed harness (or a new seeder if a table was uncovered); for a dead-letter or
drift incident, a unit/integration test that reproduces the failed path and now
passes. Reference the merged commit in the post-mortem.

---

## 9. Tabletop exercise

Run this at least once before pilot start and after any change to the tenancy or
observability surface. Time-box to 60 minutes. Use the evidence-log template (§10) —
**the walk-through itself is a logged event**, with `scenario = TABLETOP`. No
production systems are touched; this is a talk-and-point drill against real dashboards
in read-only mode.

### Scenario

> At 09:14 UTC a report reaches support: a user in **Org A** (a UAE org) says a job
> card in their jobs list shows a hull/customer name they don't recognise — it looks
> like it belongs to **another company**. The support agent captured the page digest
> `req_7f3a…`. This is a **suspected cross-org read in production**.

### The walk (each participant states the action + the exact tool/query they'd use)

1. **Triage → severity.** Cross-org visibility ⇒ **SEV-1** on the worst-plausible
   rule. IC records declaration time `09:16 UTC` — this is the notification clock
   start. Page the owner.
2. **Correlate.** Take `req_7f3a…` from the digest; filter Vercel logs to
   `request_id=req_7f3a…`; read the `org_id` / `user_id` on that request and the code
   path. Confirm on `/api/health` that `db`/`storage` are `ok` (this is not an outage).
3. **Contain first.** Pause production traffic (Vercel → pause / password-protect).
   **Freeze evidence:** do not deploy, do not run any cleanup, do not redrive. State
   out loud: "no destructive action until scope is captured."
4. **Reproduce the isolation question in a safe place.** Recognise that CI's bleed
   harness (`tests/integration/bleed-harness.test.ts`) is the authority: was the last
   deploy green on the `integration` job? If yes, this may be *data* (a mis-set
   `org_id` on a row) rather than a *policy* break; if the harness is red or was
   skipped, suspect an RLS/policy regression. Decide which by querying, as owner, the
   suspect job row's `org_id` vs. the reporting user's active org.
5. **Scope per-tenant (§5).** From `audit_log` + `domain_event.org_id` + the offending
   query, enumerate: which org's `withCtx` *saw* foreign data (Org A) **and** which
   org's data was *exposed* (Org B, the true owner of the mystery job). Establish the
   window from the first affected `request_id` to containment. Record the org list.
6. **Notify decision.** Owner/legal, holding the Org A + Org B list and the 09:16 clock
   start, determines the UAE/KSA windows and whether the regulator and/or data
   subjects must be told. IC drafts factual, per-org notices (Org A: "you were shown
   another org's data"; Org B: "your data was visible to another org"). **OWNER ACTION:
   confirm the exact window** — do not assume a number.
7. **Remediate.** If data (bad `org_id`): correct under break-glass (two-party, logged,
   post-hoc notice). If policy: fix the RLS/policy, add the failing assertion to the
   bleed harness, deploy via the normal path, `pnpm smoke:prod`, un-pause traffic.
8. **Post-mortem.** Blameless timeline; root cause to the exact policy/row; "what would
   have caught it earlier" = **the missing scheduled production tenancy canary** and
   (if applicable) unprovisioned Sentry; dated action items; **closing regression test**
   merged to `main` (a new bleed-harness assertion / seeder).

### Gaps this drill is expected to surface (and pre-answer)

- Is there a scheduled **production** tenancy canary? (Currently **no** — OWNER ACTION,
  §2.) Note it as an action item every time until it exists.
- Is **Sentry** provisioned so this wouldn't wait on a user report? (OA-4 — see
  [sentry-provisioning.md](sentry-provisioning.md).)
- Is **Upstash** rate-limiting live so `/api/health` and auth aren't the memory-store
  fallback under load? (OA-4.)
- Is **PITR** active and is a **second-provider backup** in place for the restore step?
  (OWNER ACTIONS, §7 / [restore-drill.md](restore-drill.md).)

---

## 10. Evidence-log template

Keep one entry per incident **and** per tabletop. UTC timestamps throughout. This is
the notification-clock evidence and the post-mortem spine — fill it as you go, not
after.

```
INCIDENT / TABLETOP EVIDENCE LOG
================================
ID:                 INC-YYYY-NNN         (or TABLETOP-YYYY-NNN)
Date (UTC):         YYYY-MM-DD
Type:               [ ] Real incident   [ ] Tabletop drill
Scenario:           <one line — e.g. "TABLETOP: canary suggests cross-org read in prod">

Participants:       <name — role (IC / Owner-Legal / Scribe)>, ...

Detection
  Source:           <health.checks.* | dead-letter alarm | rollup drift | storage
                     reconcile | tenancy canary | Sentry | user report>
  Signal / ids:     <exact log line, request_id, x-request-id, health snapshot>
  Detected (UTC):   HH:MM        <-- notification clock start for SEV-1
  Declared SEV:     SEV-_        at HH:MM by <IC>

Containment
  Action(s):        <rollback promote <url> | traffic paused | key rotated | none>
  Evidence frozen?  [ ] yes  (logs preserved, no destructive action pre-scope)
  Break-glass used? [ ] no  [ ] yes -> approver(s): ______  approved (UTC): ____

Per-tenant scope   (from audit_log / sign_in_log / domain_event.org_id)
  Orgs affected:    <org_id / name>, ...        (both sides for isolation)
  Window (UTC):     from ____ to ____
  Impact class:     [ ] exposure [ ] loss/corruption [ ] delayed-effect [ ] degraded

Notification
  Decision by:      <owner/legal>
  Window basis:     <UAE PDPL / KSA PDPL / other — per org country>   (OWNER-confirmed)
  Notices sent:     <org — channel — UTC — by>, ...   or  N/A (drill / not required)

Remediation
  Fix commit:       <sha>            Deployed (UTC): ____   smoke:prod: [ ] pass
  Dead-letters:     redriven? [ ] n/a [ ] yes — dead_lettered back to 0: [ ]
  Data restore:     [ ] n/a  [ ] done (target, backup timestamp, RTO)

Post-mortem
  Root cause:       <mechanism, to the code path/migration/config>
  What limited it:  <RLS / bleed harness / NOBYPASSRLS / expand-first / DL cap>
  Earlier catch:    <missing signal>
  Regression test:  <commit merged to main>       <-- required to close
  Action items:     <owner — due date — item>, ...

Gaps found (drills especially):
  - <e.g. no scheduled prod tenancy canary — OWNER ACTION>
  - <e.g. Sentry DSN not provisioned — OA-4>
```

---

## 11. Owner-provisioned dependencies referenced above

These are the credential/dashboard items incident response leans on. Each is an
**OWNER ACTION**; engineering cannot self-serve them.

| Item | Needed for | Where |
| --- | --- | --- |
| Sentry DSN (`SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`) | Push-alerting instead of user-report detection | OA-4 · [sentry-provisioning.md](sentry-provisioning.md) |
| Inngest keys (`INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY`) | Queue delivery; `/api/health` `inngest:configured` | OA-4 · [inngest-provisioning.md](inngest-provisioning.md) |
| Upstash (`UPSTASH_REDIS_REST_URL` / `_TOKEN`) | Real rate-limit store (else in-memory fallback) | OA-4 · `src/platform/http/rateLimit.ts` |
| Supabase PITR add-on | Point-in-time DB restore | [restore-drill.md](restore-drill.md) |
| Second-provider / off-Supabase backup copy | Vendor-exit / provider-outage restore | [restore-drill.md](restore-drill.md) |
| Scheduled production tenancy canary | Standing cross-org isolation alarm (vs. CI-only) | §2 — not yet built |
| Vercel + Supabase dashboard access | Pause traffic, promote rollback, read hosted status | Owner console |
