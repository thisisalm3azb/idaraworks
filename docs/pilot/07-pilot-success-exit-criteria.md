# Pilot Success + Exit Criteria

**Doc 07 of the pilot-readiness set. Owning slice: S11 (Pilot Readiness); governs the P2 pilot phase.**

This document answers three questions that the launch-criteria checklist
(`docs/pilot/06-launch-criteria-checklist.md`) does not: **what makes a pilot succeed, what makes it
fail, and when do we graduate to P2-Launch or stop.** It is the decision framework the owner uses across
the ~1-quarter pilot, not a feature list.

Source of truth: `OPERATIONS_FIRST_FOUNDATION_REPORT.md` (v2) §12 (“MVP definition — success metrics” +
the pilot design), §5 (positioning), §16 (roadmap: P2 gate), and §17 R19 (freshness risk). The pilot
design is deliberately unchanged from v1: **5–10 GCC companies, Najolatech first as a test bench (not
validation), arm’s-length pilots paying real money from month 2, ≥ 2 companies outside marine.**

---

## 1. The pilot design (what we are actually running)

| Parameter | Value | Why |
| --- | --- | --- |
| Cohort size | **5–10 GCC companies** | Enough signal to separate product truth from single-company noise; small enough to support hands-on. |
| First company | **Najolatech** — the internal boat works | Permanent test bench + source of real workflow knowledge. **Explicitly NOT product-market-fit proof** (v2 §5): it validates the boatbuilding template and the loop, not external demand. |
| Vertical spread | **≥ 2 companies outside marine** | Template #1 is boatbuilding; the operations-first claim only holds if the loop works for a general fabrication workshop / fit-out contractor too. A cohort that is all-marine cannot pass the P2 gate. |
| Arm’s length | Pilots are **real customers**, not friends doing us a favour | Friendly usage hides the churn signals we need. |
| **Commercial model** | **Free in month 1; paying real money from month 2** | See §2 — this is the single most important exit signal. |
| Onboarding | Founder-**watched**, not founder-driven | v2 §12 / §16: the owner completes “how does your business operate?” unaided; the founder observes. If it needs the founder’s hands, onboarding has failed. |
| Reconfiguration | **One mid-pilot reconfiguration per company** through the revision system | Proves the config pipeline survives contact with a changing real business (v2 §16 P2). |
| Duration | **~1 quarter** (v2 §16 P2) | Long enough to see month-2 conversion and early 90-day retention leading indicators. |

---

## 2. The paying-from-month-2 model (the core exit signal)

**Month 1 is free onboarding; from month 2 every pilot pays real money.** This is not a pricing detail —
it is the pilot’s primary truth test. The v2 positioning is explicit (§5): Najolatech and friendly usage
are *not* proof of product-market fit — *“that proof requires arm’s-length pilots paying real money.”*

- **The conversion gate is at the month-1→month-2 boundary.** A company that will not put a card down
  when the free month ends is telling you the product did not replace enough of WhatsApp-and-
  spreadsheets to be worth paying for. Count that as a **non-conversion**, not “still deciding.”
- **The headline conversion target is ≥ 5 of 8** pilots converting to paid (v2 §12 success metrics).
- Billing itself is **owner/credential-gated** (D1 merchant of record + D3 pricing + tier limits + a
  payment provider are owner actions; the state machine and read-only entitlement states are shipped and
  proven — `tooling/scripts/s11-pilot-sim.ts` exercises trial→paid→read-only). **Do not open the pilot
  until D1/D3 and a payment provider are live**, or the month-2 conversion signal cannot be collected —
  and collecting it is the point.

---

## 3. Success metrics (v2 §12) — targets and how each is measured

v1’s table stands, extended with three operations-first metrics. Targets are per v2 §12.

| # | Metric | Target | How measured (concrete) |
| --- | --- | --- | --- |
| M1 | Time-to-first-report | **< 1 day** from signup | Timestamp of the org’s first `daily_report` submit vs. org creation — `audit_log` / `domain_event` query per org. |
| M2 | Weekly-active field users | **> 60% by week 4** | Distinct report-submitting / app-active field memberships per week ÷ field seats — `audit_log` auth+submit events. |
| M3 | Daily reports per company | **≥ 4 / company / week** | Count of `daily_report` submits per org per ISO week. |
| M4 | Jobs with live costing | **> 80%** | Active jobs with a populated cost rollup ÷ active jobs — costing service read. |
| M5 | Pilot conversion | **≥ 5 / 8** | Paid subscriptions at month-2 boundary (see §2). |
| M6 | 90-day retention | **> 85%** | Orgs still active + paying at day 90 (leading indicator within the quarter; full read at P2). |
| M7 | **Owner opens Today ≥ 5 days/week by week 4** | per pilot company | Owner-role Today loads per week — auth/page instrumentation (`audit_log`; per-card instrumentation where present). *The control-system claim, measured.* |
| M8 | **Median approval response time** | **< 4 working hours** | For each decided approval: `decided_at − created_at`, working-hours adjusted via the org holiday calendar — `approval` timestamps. *Approve is the owner’s lever; if approvals sit for days the loop is dead.* |
| M9 | **The “WhatsApp test”** — operational questions still answered outside the system | **falling week over week** | Short weekly pilot survey, self-reported. *The product’s reason to exist.* |

**Measurement plumbing (be honest about what exists):** the pilot-telemetry MVP is the **audit trail +
`usage_event` (`src/modules/subscription/usage.ts`) + `/api/health`**, queried per org — not a
dashboard. Full per-tenant telemetry dashboards are **deferred / [OWNER ACTION]** (they need an
owner-provisioned metrics store; `docs/S10-HARDENING-COMPLETION.md` “feature classification”). For the
pilot, an operator runs the per-org queries above weekly and records M1–M8 in a tracking sheet; M9 comes
from the survey. Wire the survey (M9) and the weekly query set **before** the first company onboards.

---

## 4. When a single pilot SUCCEEDS

A pilot company is a **success** when, by the end of the pilot window, it clears the operational bar
**and** the commercial bar:

- **Converted (§2):** paying from month 2 and still paying. *Non-negotiable — this is the whole test.*
- **The loop is self-sustaining without us:** ≥ 4 reports/week (M3), > 60% weekly-active field users by
  week 4 (M2), foremen submitting from their own phones (not the founder entering data).
- **The owner runs on Today:** opens it ≥ 5 days/week by week 4 (M7) and can answer the thirteen
  questions from it (the live pass in `docs/pilot/06` §B, re-confirmed in real usage).
- **The money loop is real:** > 80% of active jobs carry live costing (M4); at least one full
  quote→job→invoice→payment cycle completed in-system.
- **Approvals move at phone speed:** median approval response < 4 working hours (M8).
- **The WhatsApp test is falling (M9):** week over week, fewer operational questions are answered
  outside the system.
- **It survived one reconfiguration:** the mid-pilot config change (v2 §16) applied cleanly through the
  revision system, undoable, no data loss.

---

## 5. When a single pilot FAILS (per-company kill signals)

Stop investing in a company (and log why) when, after genuine onboarding + one reconfiguration + hands-on
support, you see:

- **Non-conversion at month 2** (won’t pay) — the definitive failure. Exit-interview it: was it the
  product, the price, or the fit?
- **Reports stall** — sustained < 4/week, or field users drop below 60% weekly-active after week 4, or
  data entry has quietly reverted to the founder / a back-office clerk.
- **Today is dead** — owner opens it < 5 days/week and keeps walking the floor + scrolling WhatsApp
  (M9 flat or rising). The control-system claim did not land.
- **The money loop never closes** — jobs run without costing, or invoices/payments happen outside the
  system, so work-and-money never actually connect for them.
- **Freshness collapse** — Today is chronically stale because reports don’t come in; the screen is
  honestly showing “no data” more than it shows work (v2 §17 R19). This is a report-adoption failure
  wearing a UI complaint.

A single company failing is **data, not a verdict.** The cohort-level gate (§6) decides the product’s
fate; a couple of clean failures with clear reasons are an expected, useful pilot outcome.

---

## 6. Cohort-level outcome — graduate to P2, iterate, or stop

The pilot exists to make **one** decision at the end of the quarter, against the v2 §16 P2 gate:
**“v1 launch criteria + owner answers the 13 questions live from Today”**, now backed by real cohort
data.

### 6a. GRADUATE to P2 (Launch & deepen) when

- **≥ 5 / 8 pilots converted** to paid and are retained (M5), including **≥ 1 outside marine** — the
  operations-first claim generalises beyond the boatbuilding template.
- The cohort’s median hits the operational targets: reports/week (M3), weekly-active (M2), live-costing
  coverage (M4), approval latency (M8), owner-Today engagement (M7).
- The **WhatsApp test (M9) is falling across the cohort**, not just at Najolatech.
- **90-day retention is tracking > 85%** on the companies far enough in to read it (M6).
- The launch-criteria walk (`docs/pilot/06`) is signed with **pen-test criticals = 0** and the restore
  drill filed.

Graduating opens P2/P3 work: public GCC launch, QC capability, inventory + missing-items derivation,
ask-your-operations (read-only), template wave 2 — all per v2 §16.

### 6b. ITERATE (extend the pilot, don’t launch, don’t stop) when

- Conversion is borderline (e.g. 3–4 / 8) **but** the failures share a **specific, fixable** cause
  (a missing card on Today, one onboarding step that needs the founder, an approval threshold that
  didn’t fit) rather than “they didn’t need it.”
- Marine converts but the non-marine companies stall — template/fit work, not a product-death signal.

Action: ship the targeted fix through the normal slice discipline, re-onboard, re-measure. Do **not**
treat iteration as indefinite — set a dated second read (one more month) with the same gate.

### 6c. STOP (the hard exit) when

- **Conversion collapses** (≤ 2 / 8 pay) with **diffuse, non-fixable** reasons — companies don’t change
  how they operate, or the WhatsApp-and-spreadsheets status quo is genuinely good enough for them.
- Field adoption never takes across the cohort (M2/M3 stay low everywhere) despite hands-on support —
  the atomic input (the daily report) isn’t atomic for real crews.
- The WhatsApp test (M9) does not fall anywhere — the product isn’t replacing the thing it exists to
  replace.

Stopping is a legitimate, planned outcome (the roadmap gates “may say stop,” v2 §16). If you stop:
honour **uninstallable trust** — every pilot gets a full export (`/api/o/:orgId/export`) and a clean
close (the closure/export-first purge path, `phase2/10` #40); document the kill reasons for a future
pivot.

---

## 7. Review cadence + who decides

| Cadence | What | Inputs | Decision |
| --- | --- | --- | --- |
| **Weekly** | Per-company health read | M1–M4, M7–M9 from the per-org query set + survey; open incidents; support-impersonation log | Continue / intervene / flag a kill signal (§5) |
| **Month-1 → month-2 boundary** | **Conversion gate (§2)** | Card down? Paid? | Convert / non-convert per company (M5) |
| **Mid-pilot** | Reconfiguration exercise | One config change per company via the revision system | Config pipeline holds / doesn’t |
| **End of quarter** | **P2 go/no-go (§6)** | Full cohort M1–M9 + signed launch-criteria walk (`docs/pilot/06`) | GRADUATE / ITERATE / STOP |

**Decision owner:** the founder/owner, on the cohort data — not on Najolatech’s usage (which is a test
bench, §1) and not on any single friendly company. The operator maintains the tracking sheet and the
weekly per-org queries; incidents follow `runbooks/incident-response.md`; any direct data access during
support follows `runbooks/break-glass.md` and is tenant-audited.

---

## 8. Pre-pilot readiness dependencies (must be true before company #1 onboards)

These gate the *ability to measure success at all* — distinct from the launch-criteria walk in
`docs/pilot/06`, which gates product safety:

- [ ] **[OWNER ACTION]** Billing live end-to-end: D1 merchant/entity, D3 pricing + tier limits, a
  payment provider — without these the month-2 conversion signal (§2) cannot be collected.
- [ ] **[OWNER ACTION]** The weekly metric query set (M1–M8) written and dry-run against a synthetic org,
  and the M9 WhatsApp-test survey drafted and scheduled.
- [ ] **[OWNER ACTION]** DPA/PDPL posture + KSA lawful-transfer basis authored before any KSA company
  onboards ID documents (`phase2/10` #43).
- [ ] The launch-criteria checklist (`docs/pilot/06-launch-criteria-checklist.md`) signed **GO** —
  including pen-test criticals = 0 and the first restore drill filed.
- [ ] ≥ 2 non-marine pilot companies recruited and scheduled (the cohort cannot pass the P2 gate
  otherwise, §6a).

---

*Traceability:* pilot design + success metrics from `OPERATIONS_FIRST_FOUNDATION_REPORT.md` (v2) §12 /
§5 / §16; the P2 gate from v2 §16 and `phase2/11-mvp-delivery-plan.md` §S11 (“P2 pilot phase begins”);
the measurement surface from `docs/S10-HARDENING-COMPLETION.md` (telemetry MVP = audit trail + health,
dashboards deferred) and `tooling/scripts/s11-pilot-sim.ts` (the subscription / read-only-state / export
seams the commercial model rides on). Launch safety gates live in the companion doc
`docs/pilot/06-launch-criteria-checklist.md`.
