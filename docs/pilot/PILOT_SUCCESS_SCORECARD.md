# Pilot Success Scorecard — Controlled Pilot

**Companion to the pilot-readiness set. Owning slice: S11 (Pilot Readiness).** This is the **operational
instrument** the operator runs against the controlled pilot: a fixed set of measurable success criteria
(each with a concrete target and a named signal to read it from) plus the immediate **stop conditions**
that halt the pilot. It is the weekly-scorecard counterpart to the decision framework in
[`07-pilot-success-exit-criteria.md`](07-pilot-success-exit-criteria.md); read that first for the "why."

**Scope of THIS scorecard — a controlled pilot:** 1–2 arm's-length GCC industrial SMEs, **founder-
onboarded**, **no real payment processing**. Because billing + e-invoice are disabled in production
(`isProd()` gates `BILLING_PROVIDER` / `EINVOICE_PROVIDER` off), the **month-2 paid-conversion gate (doc
07 §2, metric M5) is deliberately OUT OF SCOPE here** and is neither a success criterion nor a stop
condition. This scorecard measures the **operational loop** — does the product replace WhatsApp-and-
spreadsheets, safely, for a real crew on a phone. The full commercial exit gate (conversion, retention,
the P2 go/no-go) lives in doc 07 §6 and applies only once D1/D3 + a payment provider are live.

**Baseline / deployment this scorecard assumes:** deployed + CI-green at commit `97985e1`, hosted Seoul
DB migrations `0000–0064` (next `0065`), production orgs = **[Alpha Marine, TESTING]** plus the pilot
org(s) the founder onboards. Never read Alpha Marine / TESTING for deletion; never write them.

---

## 1. Pilot production configuration — what is measurable, and how

Several observability + automation seams are **intentionally not provisioned** in production for a
controlled pilot. This changes *how* you collect each signal — it is honesty about the measurement
surface, not a defect. Confirm the live state any time with `GET https://idaraworks.vercel.app/api/health`.

| Seam (env var, where set) | Prod state | Effect on measurement |
| --- | --- | --- |
| Inngest (`INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — Vercel env) | **NOT set** → `/api/health` `inngest:"unconfigured"`; all crons + workers dormant; events queue durably to the outbox | The nightly **reconcile drift alarm** and exception sweep do **not** auto-run. The operator MUST run them **on demand** to read data-accuracy signals — `reconcileOrgRollups(ctx)` / `evaluateNightly(ctx)` per pilot org (see §5). |
| Sentry (`SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` — Vercel env) | **NOT set** → no error capture / push alerting | Error-rate + drift detection falls back to **`/api/health` polling + Vercel ERROR logs (`x-request-id` correlated) + user reports**. No automatic paging; the operator polls. |
| Upstash (`UPSTASH_REDIS_REST_URL`, `_TOKEN` — Vercel env) | **NOT set** → rate limits fall back to in-memory per-instance | Adequate at 1–2 org pilot scale; not a measured criterion. |
| Resend (`RESEND_API_KEY`, `EMAIL_FROM` — Vercel env) | **NOT set** → no email/notifications sent | No email nudges for pending approvals; approval turnaround (§3, S-03) is driven by in-app Today + out-of-band (phone) — factor this into the target. |
| AI narration (`AI_NARRATION_PROVIDER`) | **NOT set** → narration disabled | The **deterministic digest is the product** (S7); the thirteen-questions / Today reads do not depend on AI. No effect on any criterion below. |
| Malware scan (`SCAN_PROVIDER`) | **NOT set** → images-only uploads, re-encoded + EXIF-stripped | Upload flow works; no document (PDF) upload class in the pilot. |
| Billing / e-invoice (`BILLING_PROVIDER`, `EINVOICE_PROVIDER`) | **disabled via `isProd()`** | No real charges. The money loop for the pilot ends at **invoice issued** (+ payment recorded manually in-system), not a real payment. Conversion is out of scope (see header). |

**All secrets are set in the platform secret store (Vercel project env / Supabase) — never in the repo,
logs, or chat. This scorecard names env vars only; it never prints or stores their values.**

---

## 2. Measurement plumbing (be honest about what exists)

Per doc 07 §3: the pilot-telemetry MVP is **the audit trail + `usage_event`
(`src/modules/subscription/usage.ts`, append-only, org-scoped) + `/api/health`**, queried per org — **not
a dashboard** (per-tenant telemetry dashboards are deferred, `docs/S10-HARDENING-COMPLETION.md`). The
operator runs the per-org query set **weekly** and records the criteria below in a tracking sheet; the
qualitative items come from a short weekly pilot survey. **Wire the survey and the weekly query set before
company #1 onboards** (doc 07 §8).

Read surfaces used below, all real:

- **`audit_log`** — security/config/**financial** mutations (compliance stream; append-only, no
  UPDATE/DELETE grants). Source of auth events, financial-mutation trail, and support-impersonation rows.
- **`domain_event` / `activity`** — operational events (report submitted, approval decided, etc.).
- **`usage_event`** — billing-grade metered counts per org (`meter_key`, `period_key`).
- **`/api/health`** (+ `/api/ready` liveness) — `checks.db`, `checks.storage`, `checks.queue`
  (`unprocessed`, `oldest_unprocessed_age_s`, `dead_lettered`), `checks.inngest`.
- **`reconcileOrgRollups(ctx)`** (`src/modules/costing/service.ts`) — run on demand → `{ jobs, drifted }`.
- **`composeToday` / `getJobCosting`** — for live-costing coverage.
- **`/api/o/[orgId]/export`** (`exportEntityCsv`) — self-service export round-trip.

---

## 3. Success criteria — target + how measured

Each row is scored **weekly** and rolled up at the pilot review. `p95` performance rows tie to the
**doc 11 §11 budgets** asserted by `tooling/scripts/s5-perf-harness.ts`. Metric IDs `M#` cross-reference
doc 07 §3.

| # | Criterion | Concrete target | How measured (signal) |
| --- | --- | --- | --- |
| **S-01** | **User activation** | Every invited pilot membership logs an authenticated session within **3 days** of invite; the org's **first `daily_report` submitted < 1 working day** from go-live (M1). | `audit_log` auth events per membership; first-`daily_report` submit timestamp vs org creation (`domain_event`). |
| **S-02** | **Reporting completion** | **≥ 4 daily reports / company / week** (M3) **and > 60% weekly-active field users by week 4** (M2). | Count `daily_report` submits per org per ISO week; distinct submitters ÷ field seats — `audit_log`/`domain_event` + `usage_event`. |
| **S-03** | **Approval turnaround** | **Median approval response < 4 working hours** (M8). (No email nudges in this pilot — driven by Today + phone.) | For each decided approval: `decided_at − created_at`, working-hours-adjusted via the org holiday calendar — `approval` timestamps. |
| **S-04** | **Data accuracy** | **Zero rollup drift** on every operator-run reconcile (`drifted = 0`), **and** a per-org spot-check of one in-system job cost / invoice total vs the owner's independent figure agrees **within rounding** (template-#1 parity holds, S8). | Run `reconcileOrgRollups(ctx)` per org (Inngest dormant → on demand); assert `drifted = 0`. Spot reconciliation against owner's own numbers. |
| **S-05** | **Workflow adoption** | **> 80% of active jobs carry live costing** (M4); **owner opens Today ≥ 5 days/week by week 4** (M7); **at least one full quote → job → invoice cycle completed in-system** (payment recorded manually; no real charge); the **WhatsApp test falling week over week** (M9). | Active jobs with a populated cost rollup ÷ active jobs (`getJobCosting`); owner-role Today loads/week (`audit_log`); the money-loop trail; weekly survey (M9). |
| **S-06** | **Mobile usability** | Foremen submit reports **from their own phones** (not the founder), and the flagship flows work at **~375px** with no open sev-1 mobile-layout defect. Target: **majority of reports submitted from mobile**. | Report-submit membership (not owner) + client metadata; weekly survey; any mobile defect logged and triaged. |
| **S-07** | **Arabic + RTL usability** | **Zero open sev-1 Arabic/RTL issues** across surfaces during the pilot (A4 native-reviewer sign-off holds); Arabic-locale users complete core flows without switching to English. | `user_profile.locale` distribution; support log tagged `rtl`/`i18n`; weekly survey. |
| **S-08** | **Performance (§11 budgets)** | **Today compose p95 < 1.5s** and **job-costing read p95 < 1.5s** (co-located targets); **report submit < 10s** (incl. one photo on 3G); **nightly reconcile < 5 min/org**. | CI perf gate green at synthetic volume (`s5-perf-harness.ts`, `PERF_COLOCATED=1`); **field p95** observed from request timing during the pilot. *See the Seoul caveat below.* |
| **S-09** | **Support requests** | Support / impersonation requests **trend down week over week**; **no single unresolved blocker > 48h**. | Support inbox; consent-gated impersonation sessions dual-logged in the **tenant's own** `audit_log` (`runbooks/impersonation-history.md`). |
| **S-10** | **Error rates** | `/api/health` `ok:true` (db + storage 200) **sustained**; **`checks.queue.dead_lettered = 0`**; unhandled-error rate **near zero**. (Sentry off → poll `/api/health` + Vercel ERROR logs.) | Weekly `/api/health` snapshot; Vercel ERROR-log scan (`x-request-id` correlated); `smoke:prod` read-only run. |
| **S-11** | **Exports (uninstallable trust)** | Full export **works on demand** for every pilot org — paged, redaction-aware, formula-injection-safe — **100% success, complete data**. | `/api/o/[orgId]/export` round-trip per org; export column-probe (8/8 in CI). |
| **S-12** | **Zero isolation / financial-integrity incidents** | **0** tenant-isolation events, **0** unauthorized cost/labour exposures, **0** rollup-drift/data-corruption events, **0** incorrect financial totals — for the whole pilot. This is the **hard bar**; any occurrence is a **stop condition (§5)**. | Bleed harness green on every deploy; `reconcileOrgRollups` `drifted = 0`; export money-wall holds; no field report of cross-org visibility. |

> **§11 performance — the Seoul-latency caveat (be honest).** The tight per-request `p95 < 1.5s` budgets
> are **co-located** targets (app + DB in one region) and are enforced only on a co-located
> `PERF_COLOCATED=1` run (`docs/S10-HARDENING-COMPLETION.md` "CI perf gate note"). Production is Vercel
> `icn1` ↔ Supabase **Seoul** — a transcontinental hop for GCC users, so **field p95 is dominated by
> network RTT** (an accepted MVP trade-off, `phase2/13-ARCHITECTURE-FREEZE.md`; revisit only via
> change-control on real pilot telemetry against these budgets). For the pilot: the CI budgets guard
> against O(rows) regressions; **measure field p95 from the Gulf** and treat a sustained, experience-
> degrading field p95 as an ITERATE signal (region decision), not a code regression.

---

## 4. The zero-incident bar (non-negotiable)

Criterion **S-12** is the line the pilot must not cross. Two classes, both proven pre-pilot and both with
a live detection path:

- **Tenant isolation** — no org ever reads or writes another org's rows. Proven pre-pilot by the two-org
  **bleed harness** (`tests/integration/bleed-harness.test.ts`, 17/17) which **gates every deploy**, and
  by the RLS second wall (NOBYPASSRLS, per-request GUC, no DELETE grants). *There is not yet a scheduled
  production tenancy canary* (owner action, `runbooks/incident-response.md` §2) — so during the pilot,
  **any field report of cross-org visibility is an immediate SEV-1** and a stop.
- **Financial integrity** — costs, margins, labour, and invoice/AR totals are correct and only visible to
  cost/price-privileged readers. Proven by the costing golden + template-#1 parity (S8), the per-subject
  redaction walls (S10), and the two-org pilot sim's money-wall + redaction assertions
  (`tooling/scripts/s11-pilot-sim.ts`). Live detection: the **rollup drift alarm** and the **export
  money-wall**.

Any breach of either class triggers the matching stop condition in §5.

---

## 5. Immediate STOP conditions — detection signal → immediate action

Each condition **halts the pilot** (stop onboarding new activity; contain; do not continue collecting
"success" data over a broken foundation). Every one maps to a **real signal** and to the incident runbook.
Declare severity from the **worst plausible** reading (`runbooks/incident-response.md` §3), then downgrade
only on evidence.

| # | Stop condition | Detection signal (real) | Immediate action |
| --- | --- | --- | --- |
| **STOP-1** | **Tenant-isolation failure** — one org sees or writes another org's data. | **Field report** of cross-org visibility (SEV-1 by default — no prod canary yet); **or** the bleed harness fails in CI on a deploy; **or** a future production tenancy canary pages. | **SEV-1. Contain before diagnosing:** pause production traffic (`incident-response.md` §4), page the owner, preserve evidence. **HALT the pilot** until root-caused, fixed, and the bleed harness is re-green; then per-tenant scope + notify affected tenants (§5/§6 of the runbook). |
| **STOP-2** | **Unauthorized financial / labour-cost exposure** — a non-cost/-price reader sees cost, margin, or labour figures (redaction-wall breach). | Field report; **or** an export money-wall regression (a 6+-digit money value present for a non-price exporter — the `s11-pilot-sim` money-wall assertion inverted); **or** export column-probe regression in CI. | **SEV-1.** Contain the leaking surface (disable the export / revoke the view). Scope which tenants + subject-types were exposed via `audit_log`. Notify the affected tenant. **HALT** until the redaction wall is restored and re-proven. |
| **STOP-3** | **Data corruption** — persisted state no longer matches source of truth. | **Rollup drift alarm** — ERROR `cost rollup drift detected — cache differed from recompute (missed invalidation)` from `reconcileOrgRollups` (run on demand — Inngest dormant); **or** storage-reconcile `orphanKeys > 0`; **or** a restore-drill verification count mismatch; **or** any DB integrity/constraint violation. | **SEV-1/2 by scope.** Freeze writes on the affected org, recompute the rollup from source; if unrecoverable, restore from **PITR / nightly backup** per `runbooks/restore-drill.md` (RPO ≤ 1h / RTO ≤ 4h). **HALT** until the org reconciles clean (`drifted = 0`). |
| **STOP-4** | **Incorrect financial totals** — an in-system cost or invoice/AR total is wrong. | A per-org **reconciliation spot-check** diverges from the owner's independent figure beyond rounding; **or** the rollup drift alarm; **or** a **template-#1 parity** regression (S8 golden). | **SEV-2.** Quarantine the figure (flag it, stop money-facing use of that org's numbers). Trace via the `audit_log` financial-mutation stream + recompute; correct and root-cause the calculation path. **HALT** money-facing use until parity is re-proven. |
| **STOP-5** | **Unrecoverable workflow failure** — a core flow (report submit, approval decide, costing, export) is broken for all orgs and cannot be recovered in place. | `/api/health` degraded / sustained 503; **or** a core flow throwing for every org (Vercel ERROR logs, `x-request-id` correlated); **or** the offline outbox stuck (`checks.queue.oldest_unprocessed_age_s` climbing, exactly-once failing). | **SEV-2 → escalate.** **Roll back** to the last CI-green deploy (`runbooks/deployment-and-rollback.md`); if the outbox is stuck, `runbooks/queue-worker-recovery.md` / `dead-letter-recovery.md`. If still unrecoverable, **pause the pilot**, tell the pilot orgs, and offer a full export (uninstallable trust). |
| **STOP-6** | **Serious security incident** — credential leak, auth bypass, confirmed IDOR, or an externally reported vulnerability. | gitleaks / secret-scan hit; auth-bypass or IDOR evidence in logs; a **pen-test critical** surfacing mid-pilot; a credible external report. (Sentry off → Vercel ERROR logs + reports are the channel.) | **SEV-1.** Contain: **rotate the affected secret** (`runbooks/secret-rotation.md`), **revoke sessions / access** (`runbooks/access-revocation.md`), and if a tenant boundary is in doubt treat as STOP-1. Scope per-tenant; notify within the regulatory window (`incident-response.md` §6). **HALT** until remediated and re-tested. |

**Halt protocol (all conditions):** (1) declare severity + record the UTC detection time (SEV-1 → that is
the notification-clock start); (2) contain per the runbook *before* diagnosis; (3) preserve evidence
(never clean up first); (4) scope which tenants are affected via `audit_log` before any external message;
(5) log the event on the pilot tracking sheet with the signal, the action, and the resolution. Any direct
data access during a stop follows `runbooks/break-glass.md` (two-party, `DIRECT_URL`-only, post-hoc
tenant notice) and is tenant-audited.

---

## 6. Review cadence + the pilot decision

Cadence and decision ownership are per doc 07 §7 — this scorecard is the sheet the operator fills each
week:

| Cadence | What to read | Outcome |
| --- | --- | --- |
| **Weekly** | S-01…S-12 from the per-org query set + survey; `/api/health` snapshot; a **manual `reconcileOrgRollups` run** (Inngest dormant); open incidents; the impersonation log. | Continue / intervene / **flag a stop condition (§5)**. |
| **Mid-pilot** | One reconfiguration per company through the revision system (doc 07 §7). | Config pipeline holds / doesn't. |
| **End of pilot** | Roll up S-01…S-12; feed the operational picture into the doc 07 §6 framework. | **CONTINUE** (operational bar met, no stops) / **ITERATE** (fixable misses — e.g. Seoul field p95, one onboarding step) / **STOP** (a §5 condition unresolved, or adoption never takes). |

**Decision owner:** the founder/owner, on the pilot data — not on Alpha Marine / TESTING (test benches).
The operator maintains the tracking sheet and the weekly per-org queries. Incidents follow
`runbooks/incident-response.md`.

> **What this scorecard does NOT decide.** It measures the operational loop only. The **commercial P2
> go/no-go** — paid conversion (M5), 90-day retention (M6), ≥ 2 non-marine companies, pen-test criticals =
> 0 signed — lives in **doc 07 §6** and applies once real payment (D1/D3 + a provider) is live. A clean
> controlled pilot here is the evidence that *opens* that gate, not a substitute for it.

---

*Traceability:* success framework + metric IDs from
[`07-pilot-success-exit-criteria.md`](07-pilot-success-exit-criteria.md) (v2 §12); launch-safety gates
from [`06-launch-criteria-checklist.md`](06-launch-criteria-checklist.md); performance budgets from
`phase2/11-mvp-delivery-plan.md` §11 + `tooling/scripts/s5-perf-harness.ts` +
`docs/S10-HARDENING-COMPLETION.md`; detection signals + severity from `runbooks/incident-response.md` §2/§3
(rollup drift alarm = `src/modules/costing/service.ts::reconcileOrgRollups`; tenancy proof =
`tests/integration/bleed-harness.test.ts`); redaction / money-wall / isolation proofs from
`tooling/scripts/s11-pilot-sim.ts`; production config from `docs/MVP-READINESS-REPORT.md` +
`src/platform/observability/health.ts`. Owner pre-pilot dependencies:
[`08-owner-action-checklist.md`](08-owner-action-checklist.md).
