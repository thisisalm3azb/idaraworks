# Pilot Support Checklist — Runbook & Escalation Matrix

**Doc of the pilot-readiness set (`docs/pilot/`). Owning slice: S11 (Pilot Readiness).**

**One-line rule:** when a pilot user reports a problem, you **capture the
correlation id**, **triage it against `/api/health` + Vercel logs first**, then —
if you need to *see* the tenant's state — use the **consent-gated support
impersonation** path (S9), which is RLS-scoped, banner-shown, and dual-logged to
the tenant's own audit log. Raw-DB **break-glass** is the last resort, only when
impersonation cannot reach the problem. Every problem gets a **severity** (§4) and
the response, owner, and escalation that severity dictates. Nothing here contains
or requires a secret value — provisioning any disabled seam is an **[OWNER
ACTION]** named in `docs/pilot/08-owner-action-checklist.md`.

**Read alongside:** `runbooks/incident-response.md` (the incident lifecycle a
Severity-1 support case becomes), `runbooks/impersonation-history.md` (the normal
way to see a tenant's state), `runbooks/break-glass.md` (the raw-DB escalation),
`runbooks/access-revocation.md` (off-boarding / compromised accounts),
`runbooks/credential-disabled-operations.md` (the definitive "what still works vs.
what is degraded" for every disabled seam — most pilot "bugs" are explained here).

**Pilot posture this assumes** — the controlled, founder-onboarded, **no-real-
payment** pilot on `https://idaraworks.vercel.app`: DB + storage are the only
always-on dependencies; Inngest, Sentry, Upstash, Resend, OAuth, malware scan, AI
narration, billing, and e-invoice are all **disabled seams by design**
(`credential-disabled-operations.md`). A solo operator (the owner,
`abdullaalojan@gmail.com`) wears every role below until a support team exists.

---

## 1. Support roles (who does what)

| Role | Who (pilot default) | Owns |
| --- | --- | --- |
| **First-line support / operator** | The founder / on-call operator | Intake, capture the correlation id, triage against `/api/health` + logs, resolve or classify severity, drive impersonation |
| **Incident Commander (IC)** | Owner by default (pre-team) | Any case that reaches Severity 1/2: declares severity, drives `incident-response.md`, holds the UTC timeline |
| **Owner / Legal decision-maker** | Product owner (`abdullaalojan@gmail.com`) | Break-glass approval, tenant notification decision + exact regulatory window, any tenant-facing message, `platform_staff` roster |

Solo operation is expected: one person holds all three hats but still **writes the
timeline as they go** for anything Severity 1/2 (§4) — it is the post-mortem spine
and the regulatory-clock evidence (`incident-response.md` §1, §10).

---

## 2. Intake — how a pilot user reports a problem, and what to capture

There is **no ticketing integration wired** for the pilot (messaging seams are
disabled — `credential-disabled-operations.md` §8). Intake is a direct channel the
founder gives each pilot org at onboarding (email/WhatsApp/phone to the operator).
The job of intake is to capture **enough to correlate the report with a server log
line** before anything else.

### 2.1 The correlation id — the single most useful thing to capture

Every response IdaraWorks serves carries an `x-request-id` header, **server-minted
in middleware** and echoed on the way out (`src/middleware.ts`,
`src/platform/observability/requestId.ts`). An inbound client-supplied value is
**deliberately ignored and overwritten** — the id is always ours, so it is
trustworthy for log correlation. Two ways a pilot user surfaces it:

- **On a crash / error page (`src/app/error.tsx`):** the page shows a short,
  bilingual, safe message ("Something went wrong · حدث خطأ ما") and a **code** —
  Next's error **digest**. It exposes **no internals, no stack, no tenant values**.
  That digest pairs with the server-side `unhandled request error` log line
  (`src/instrumentation.ts`) and with the response `x-request-id`. **Ask the user
  to read you the code, or screenshot the whole error page.**
- **On any other response (wrong data, but no crash):** the `x-request-id` is a
  **response header** an ordinary pilot user will not see. Do **not** ask a
  workshop-floor user to open dev tools. Instead capture the *reproduction facts*
  below and pull the id yourself by reproducing under impersonation (§3) and
  reading it off the request in Vercel logs.

### 2.2 Intake capture template

Capture this for every report. Keep it **identifiers-only** — do not paste tenant
business values (names, prices, customer data) into a shared channel beyond the
minimum needed to reproduce; logs are identifiers-only at info+ by design and this
posture must extend to support notes (privacy parity with `incident-response.md`).

```
SUPPORT INTAKE  ---------------------------------------------------------------
  Received (UTC) ......:  <convert the user's local time; pilot orgs are AE/SA>
  Reporter ............:  <name / role — foreman, admin, accounts, owner>
  Org .................:  <org name or id>          (NOT Alpha Marine / TESTING — those are baseline, not pilot)
  What they were doing :  <the exact screen + action — "submitting daily report", "approving PO">
  Correlation id ......:  <error-page digest, or x-request-id if known, else "to reproduce">
  Error page shown? ...:  <yes → digest ____ / screenshot | no → describe wrong behaviour>
  Reproducible? .......:  <always | sometimes | once>
  Expected vs actual ..:  <one line each>
  Severity (§4) .......:  <1 | 2 | 3 | 4>       (declare from worst-plausible; downgrade on evidence)
-------------------------------------------------------------------------------
```

### 2.3 "Is this a known disabled-seam behaviour?" — check BEFORE escalating

The most common pilot "bugs" are **intended disabled-seam degradations**, not
defects. Screen §5 against this table first — resolving here avoids a false
Severity-1 and a wasted impersonation session. Full detail:
`runbooks/credential-disabled-operations.md`.

---

## 3. Seeing the tenant's state — impersonation first, break-glass last

Most reports need you to **look at what the tenant sees**. The normal, safe way is
**S9 consent-gated support impersonation** — never a raw DB connection, and never
"just log in as them."

### 3.1 The normal path — consent-gated support impersonation (S9)

`src/modules/support/service.ts` (`startImpersonation` / `endImpersonation` /
`listImpersonations` / `hasActiveImpersonation`), migration
`0056_s9_impersonation.sql`. Full review/query set:
`runbooks/impersonation-history.md`.

What makes it the safe default:

- **RLS-scoped.** The session runs as `app_user` under Row Level Security — it can
  see **only** that one org, cannot silently cross into another tenant.
- **Consent-gated or logged break-glass.** A session is opened either with a tenant
  **owner/admin** consent (`consentGrantedBy`) **or** a logged in-app `breakGlass`
  override — the DB enforces one of the two exists (`impersonation_consent_ck`).
- **Time-bounded + tenant-visible.** The tenant sees a **persistent banner** in
  `Settings → Subscription` while any session is open (`hasActiveImpersonation`),
  and both start and end are **dual-logged to the tenant's own `audit_log`**
  (`support.impersonation_started` / `_ended`) as well as the platform stream.
- **Staff-gated.** Only a member of the `public.platform_staff` allow-list can open
  one. A tenant user cannot; a session can never open into the wrong org.

Operational rules for the pilot operator:

1. **There is no in-app "start impersonation" button.** Sessions are opened from a
   platform/tooling context — see the call shape in `tooling/scripts/s9-prod-demo.ts`
   and `tooling/scripts/s11-pilot-sim.ts`. Opening one is an **[OWNER ACTION]-
   adjacent, platform-staff-gated** step.
2. **Prefer explicit consent.** For a routine support case, ask the tenant
   owner/admin to grant access (pass their user id as `consentGrantedBy`). Use the
   in-app `breakGlass=true` override only for a genuine emergency where you cannot
   get consent in time — and know that **every break-glass session owes the tenant
   a post-hoc notice** (`impersonation-history.md` §4; owner decides the window).
3. **Always close the session** when done — `endImpersonation(<sessionId>)`. It is
   idempotent and dual-logged, so the banner clears and the tenant's audit log
   records the end. A lingering open session is a finding
   (`impersonation-history.md` §4/§5); never close it with a raw `update`.
4. **Reproduce and read the id.** Inside the session, reproduce the reported action
   and pull the `x-request-id` / `request_id` off that request in Vercel logs — now
   you have the correlation id for a non-crash report (§2.1).

### 3.2 The escalation path — raw-DB break-glass (last resort only)

`runbooks/break-glass.md`. This is a human connecting **directly to production over
`DIRECT_URL`, bypassing the app and RLS** — the most privileged action in the
system. Escalate to it **only** when impersonation genuinely cannot do the job:

- the app is down (impersonation runs *through* the app),
- the tenancy/RLS layer is itself the suspected fault,
- the work is sub-application (migration wedged, outbox internals, corruption
  repair, forensic cross-tenant read).

Non-negotiables when you must (`break-glass.md` §3): **two-party approval recorded
BEFORE access** (Approver ≠ Operator; owner is the default Approver), `DIRECT_URL`
credentials only (**never** the app runtime, never a service-role key in Vercel),
**read-only by default** (`begin transaction read only`), **no DELETE/purge**
without a separate written approval, honour **legal hold**, and **post-hoc tenant
notification + a manual `app.record_platform_audit` row** for every org whose data
was viewed. Fill the break-glass log (`break-glass.md` §9).

> Keep the two "break-glass" meanings distinct: the in-app
> `impersonation_session.break_glass = true` (still RLS-scoped, banner-shown,
> tenant-audited) is **not** the raw-DB break-glass of `break-glass.md` (off-RLS,
> owner role). Reach for the in-app one first; the raw one is strictly higher.

### 3.3 Off-boarding / compromised-account reports

If a pilot reports a compromised account, a departing employee who still has
access, or "remove this person," do **not** improvise — follow
`runbooks/access-revocation.md`. Revocation is **layered**: (1) deactivate the org
membership in-app (`Settings → Members`, `members.deactivate`, owner/admin only —
severs data at the next request via RLS); (2) for a compromise, force a **global
sign-out** ([OWNER ACTION], Supabase Dashboard → Authentication → Users → *Sign out
user*, since Layer 1 does not kill the live token); (3) for a departing **platform
operator**, also end their open impersonation sessions and set
`platform_staff.active = false` ([OWNER ACTION]s). Never hard-delete the auth user
(prohibited destructive action).

---

## 4. Escalation matrix

Declare severity from the **worst-plausible** reading of the signal, then downgrade
only once evidence rules the worse case out (`incident-response.md` §3). For
Severity 1, **record the declaration time in UTC** — for an isolation/breach case
this timestamp is the notification-clock start.

The four support severities map onto the incident ladder in `incident-response.md`:
a **Severity 1 or 2 support case IS an incident** — open the incident lifecycle and
the evidence log (`incident-response.md` §10). Severity 3/4 are support tickets.

### Severity 1 — security / isolation / corruption / financial-integrity

- **Definition.** Any suspicion of: cross-org data visible or writable
  (tenant-isolation break); data loss or corruption; a **financial-integrity**
  failure (a redaction wall exposing cost/price to a non-privileged reader, a wrong
  money figure a tenant *acted on*, a subscription/entitlement gate letting a
  blocked action through, cross-org money visibility); or a full outage
  (`/api/health` sustained 503).
- **Response expectation.** **Immediate.** Contain first, diagnose second. Page the
  owner. Response measured in minutes, not hours.
- **Owner.** IC (owner) drives; Owner/Legal owns any notification decision.
- **Escalation path.** First-line → IC **now** → open `incident-response.md`
  (detect → **contain** → **scope per-tenant** → notify → remediate → post-mortem).
  For isolation: **pause production traffic** (Vercel) and **freeze evidence — no
  cleanup, no redrive, no deploy — before scoping.** Owner/Legal determines the
  UAE/KSA PDPL window (an **[OWNER ACTION]** determination, never a hard-coded
  number). Any direct data access during containment is break-glass (§3.2).
- **Temporary workaround.** There is **no** "leave it running" workaround for a
  suspected isolation/financial-integrity break — **containment is the workaround**
  (pause traffic / rollback if deploy-linked per `deployment-and-rollback.md`).
  Isolation is `NOBYPASSRLS` + no-delete-grant by construction, so a genuine
  cross-org read implies a platform fault; preserve the offending code path + logs
  as the whole post-mortem. Closure requires a **regression test merged to `main`**
  (`incident-response.md` §8) — for isolation, a bleed-harness assertion.

### Severity 2 — workflow blocker

- **Definition.** A core operational flow is broken with **no usable workaround**
  for the affected user(s): login / org load / uploads fail, a foreman cannot
  submit a daily report, an approver cannot decide, a PO/GRN/invoice cannot be
  created. Also: queue **dead-letters accumulating**, or a rollup/storage **drift
  alarm** firing (`incident-response.md` §3).
- **Response expectation.** **Same business day.** Contain via **rollback** if
  deploy-linked.
- **Owner.** First-line/operator; escalate to IC (owner) if not contained same day,
  or **re-classify to Severity 1** the moment isolation/financial-integrity is
  implicated.
- **Escalation path.** Correlate the `request_id`/digest in Vercel logs → confirm
  the failing dependency on `/api/health` → if a bad deploy, roll back
  (`deployment-and-rollback.md`: `vercel promote <previous-ready-prod>` →
  `pnpm smoke:prod`, migrations are forward-only so no data rollback). Dead-letters:
  **do not redrive yet** — diagnose root cause first
  (`runbooks/dead-letter-recovery.md`), redrive is a *post-fix* action.
- **Temporary workaround.** Offer an alternate path where one exists (e.g. capture
  the report on paper / re-enter after the fix; hand an invite link out-of-band if
  the blocker is email delivery). If the blocker is a **dormant worker** side
  effect (not a synchronous write), the underlying write already committed
  (`credential-disabled-operations.md` §1) — you can run the dormant work on demand
  (relay / lifecycle / nightly) per `runbooks/queue-worker-recovery.md`.

### Severity 3 — degraded experience (workaround exists)

- **Definition.** Something is wrong or slow but the user **can still get the job
  done**: a cosmetic/RTL glitch, a single-org non-isolation quirk, a slow screen, a
  **known disabled-seam degradation** the user found surprising (stale costing
  screen pending a rollup, no stored PDF to download, no email received).
- **Response expectation.** **Next working day.** Still gets a timeline entry if it
  is user-facing.
- **Owner.** First-line/operator.
- **Escalation path.** Handle directly. Escalate to IC only if it **recurs across
  multiple orgs** (may be a latent Severity 2) or the workaround proves
  insufficient.
- **Temporary workaround.** Usually the disabled-seam substitute from §5 — share
  the on-screen document instead of a PDF; hand the invite link directly; explain
  the costing screen self-heals on the next rollup / on-demand relay. Log it so a
  recurring Severity 3 gets promoted.

### Severity 4 — enhancement

- **Definition.** Not broken — a request for a new capability, a preference, or a
  scope-guard item deliberately **out of MVP** (GL, payroll, stock, QC, public API,
  WhatsApp, templates #2–3, etc. — see `docs/MVP-READINESS-REPORT.md` "Deferred").
- **Response expectation.** **Acknowledge**, log to the backlog; no fix commitment.
- **Owner.** First-line/operator logs it; owner reviews at the pilot cadence.
- **Escalation path.** None. Reviewed at the weekly pilot check-in against
  `docs/pilot/07-pilot-success-exit-criteria.md`.
- **Temporary workaround.** Set expectation: state plainly it is out of pilot scope
  and capture it as pilot feedback (an input to the exit-criteria review, not a
  defect).

### Matrix at a glance

| Sev | Trigger | Response | Owner | Escalates to | Workaround |
| --- | --- | --- | --- | --- | --- |
| **1** | isolation / corruption / financial-integrity / full outage | Immediate; contain first, page owner | IC (owner) + Owner/Legal | `incident-response.md` full lifecycle | Containment *is* the workaround (pause/rollback) |
| **2** | workflow blocker, no usable path; dead-letters; drift alarm | Same business day | Operator → IC | Rollback (`deployment-and-rollback.md`); re-class to Sev 1 if isolation/money | Alternate path / on-demand worker run |
| **3** | degraded, workaround exists; known disabled-seam surprise | Next working day | Operator | IC if multi-org / recurring | Disabled-seam substitute (§5) |
| **4** | enhancement / out-of-MVP request | Acknowledge + backlog | Operator | — (pilot-cadence review) | State scope; log as pilot feedback |

---

## 5. Known disabled-seam behaviours — resolve at first line (not incidents)

These are **intended** for the pilot (`runbooks/credential-disabled-operations.md`).
Recognising one turns a would-be Severity 1/2 into a Severity 3/4 explanation.
Confirm the ground truth on `GET /api/health` and by the env-disabled state — never
claim a seam is active.

| Report | What's actually happening | Severity | First-line response / workaround |
| --- | --- | --- | --- |
| "I never got the invite email" | Resend not provisioned (`RESEND_API_KEY` unset) → `sendEmail` is a dev sink; the invite **row + token** still exist | 3 | Hand the invitee the accept link (`<APP_URL>/invite/<token>`) out-of-band; acceptance works fully (`credential-disabled-operations.md` §8) |
| "My PO/invoice PDF won't download" | PDF render seam gated (no render runtime + Inngest dormant); the bilingual **HTML is built** but no `financial_doc` file is stored | 3 | Share the on-screen document; **do not promise a downloadable stored PDF** (§2) |
| "The costing screen looks stale / wrong margin" | Cost-rollup invalidation is a **dormant worker** (Inngest unconfigured); the cache can lag its inputs | 3 (→ investigate if a tenant *acted* on it → Sev 1 financial-integrity) | Runs on the next rollup or on-demand relay (`queue-worker-recovery.md`); nightly reconcile self-heals. If a wrong figure drove a decision, escalate |
| "My invoice isn't government-cleared / no QR" | E-invoice provider **disabled in prod** via `isProd()` | 3 | Correct behaviour; **do not represent pilot invoices as ZATCA/tax-cleared** (§3 of the seam runbook) |
| "Upgrade / checkout doesn't work" | Billing provider **disabled in prod** (D1); subscription is **operator-administered** for the pilot | 3/4 | Expected — no real payment in the pilot; webhooks are rejected, no card data touched |
| "The queue's unprocessed count is climbing" | Inngest dormant → outbox **durably accumulates, at-least-once by design** | 3 | Expected; drains the moment the relay runs / Inngest is provisioned. **Not** a leak or data loss |
| "No push/email notification arrived" | In-app notifications **fully work**; email/push fan-out rides a disabled seam | 3 | Point the user to in-app notifications; email delivery is [OWNER ACTION] `RESEND_API_KEY` |
| "The AI summary text is missing" | AI narration **disabled in prod**; the **deterministic digest IS the product** | 4 | Expected — the digest stands on its own; narration is an optional wording layer |
| Dead-letter alarm didn't page anyone | Sentry **no-op** (no DSN) → the `outbox_dead_letter` page alert is silent | 2 (the dead-letters), — (the silence is expected) | **Watch `/api/health` `checks.queue.dead_lettered` yourself**; an uptime monitor on `/api/health` covers it (`credential-disabled-operations.md` §6) |

Anything **not** on this list, and any report touching **isolation, corruption, or
money correctness**, is a real defect — classify by §4.

---

## 6. First-line triage probes (read-only, safe anytime)

Run these before escalating; they establish whether a dependency is actually down
and give you the ground truth to attach to the ticket.

```bash
# Git-Bash / Linux
curl -s https://idaraworks.vercel.app/api/health | jq '{ok, commit, checks}'
curl -s https://idaraworks.vercel.app/api/ready                    # dependency-free liveness
EXPECTED_COMMIT=$(git rev-parse HEAD) pnpm smoke:prod              # full read-only prod smoke (18/18)
```

```powershell
# PowerShell
Invoke-RestMethod https://idaraworks.vercel.app/api/health | ConvertTo-Json -Depth 6
$env:EXPECTED_COMMIT = (git rev-parse HEAD); pnpm smoke:prod
```

Reading `/api/health`:

- **`db` / `storage`** are the only two checks that gate HTTP status (200 vs 503).
  A sustained 503 here = outage = Severity 1. `/api/ready` still 200 distinguishes
  "our process is up, a dependency is down" from "our process crashed."
- **`queue`** is informational — `dead_lettered > 0` raises `alert:true` but never
  503s. Accumulating `unprocessed` is expected while the relay is dormant (§5).
- **`inngest.status = "unconfigured"`** is the **explicit, expected** pilot default
  — never treat it as an unexplained failure.

**Correlate a report to a log line:** take the digest / `x-request-id`, open
**Vercel → Project → Logs**, filter to that `request_id` (every request-scoped line
is tagged `request_id` / `org_id` / `user_id`; **no tenant business values at
info+**), and confirm the failing dependency against `/api/health`. The deployed
commit is stamped in `/api/health.commit` (expected: the CI-green prod commit,
`97985e1`; hosted DB migrations `0000–0064`).

---

## 7. Pilot support log template

Keep one entry per report (extends §2.2 with the resolution). Anything that reaches
Severity 1/2 **also** gets the full `incident-response.md` §10 evidence log — this
support log is the lighter record for Severity 3/4 and the pointer for 1/2.

```
PILOT SUPPORT LOG  ------------------------------------------------------------
  Ticket ..............:  SUP-<YYYYMMDD>-<n>
  Received (UTC) ......:  ____        Reporter/Org: ____ / ____
  Correlation id ......:  <digest / x-request-id>       Repro: <yes/no>
  Severity ............:  <1|2|3|4>   Declared (UTC): ____   by: ____
  Known disabled seam? :  <no | which one (§5)>
  Impersonation used? .:  <no | session id ____ , consent by ____ / break-glass , ENDED? [ ]>
  Break-glass used? ...:  <no | BG-id ____ (break-glass.md §9)>
  Diagnosis ...........:  <root cause to code path / dependency / seam>
  Resolution ..........:  <fix commit / rollback / workaround given / out-of-scope>
  Incident log ........:  <INC-YYYY-NNN if Sev 1/2, else N/A>
  Tenant notified? ....:  <N/A | org — channel — UTC — by>   (mandatory for break-glass / breach)
-------------------------------------------------------------------------------
```

---

## 8. Cross-references

- `runbooks/incident-response.md` — the detect→contain→scope→notify→remediate→
  post-mortem lifecycle a Severity-1/2 support case becomes; severity ladder,
  per-tenant scoping, regulatory windows, evidence-log template.
- `runbooks/impersonation-history.md` — the **normal** way to see a tenant's state;
  review who impersonated whom, the `impersonation_session` query set, consent vs.
  in-app break-glass, closing a lingering session.
- `runbooks/break-glass.md` — the **raw-DB** escalation (two-party approval,
  `DIRECT_URL`-only, least-privilege, post-hoc tenant notice) when impersonation is
  insufficient.
- `runbooks/access-revocation.md` — layered off-boarding / compromised-account
  handling (membership → auth session → platform-staff → break-glass).
- `runbooks/credential-disabled-operations.md` — the definitive "what still works
  vs. degraded" per disabled seam; the source for §5 and the `/api/health` reading.
- `runbooks/deployment-and-rollback.md` — rollback (the Severity-2 containment) and
  the prod smoke.
- `runbooks/dead-letter-recovery.md` · `runbooks/queue-worker-recovery.md` —
  diagnosing dead-letters and running the dormant relay/workers on demand.
- `docs/pilot/08-owner-action-checklist.md` — every [OWNER ACTION] / credential
  referenced here (Inngest, Sentry, Upstash, Resend, PDF runtime, PITR, DPA).
- `docs/MVP-READINESS-REPORT.md` — capability classification + the "Deferred beyond
  MVP" scope-guard list that defines Severity-4 out-of-scope.
- Code this runbook drives: `src/middleware.ts` +
  `src/platform/observability/requestId.ts` (correlation id), `src/app/error.tsx`
  (safe error page + digest), `src/modules/support/service.ts` +
  `supabase/migrations/0056_s9_impersonation.sql` (impersonation),
  `src/platform/observability/health.ts` + `src/app/api/health/route.ts` (health),
  `tooling/scripts/smoke-prod.ts` (`pnpm smoke:prod`).
