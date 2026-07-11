# 03 — Today Screen Specifications

**Purpose:** the Today screen is the product's anchor surface (v2 §12–13): a role-specific answer to "what is happening, what is late, what needs me, what is at risk, what should I decide now." This document specifies each role's screen as a **card inventory with data contracts** — every number traced to a query or exception rule (doc 04), never typed by a human.

Design rules (apply to all roles): ≤6 cards per screen at launch; every card deep-links to the underlying records; every card shows **freshness** (see D-3.2); cards render in both languages and RTL; field-role screens are designed at 375 px first; empty states are calls-to-action, not blanks; card visibility = role ∧ enabled capability ∧ template card config (doc 08 selects and orders cards per role).

---

## D-3.1 — Today payloads are server-composed per role, one endpoint per screen

**Decision:** a single server endpoint per role screen assembles all card payloads (queries + open exceptions from doc 04), returns one typed document, cached ~60s per user.
**Why:** the screen is the product's hottest read and its correctness contract; one composition point means one place for tenancy checks, cost-visibility redaction (doc 06), terminology resolution, and freshness stamping — and one thing to load-test.
**Alternatives rejected:** client-composed from per-capability APIs (N requests on a workshop phone connection; redaction logic duplicated in the client — a cost-leak risk); real-time socket-pushed cards (v1 §9 rule: nothing may *require* a socket; refresh-on-focus + short cache is enough for a daily rhythm).
**Risks:** the endpoint becomes a god-function — mitigated by card assemblers registered per capability behind one composer interface; a card whose capability is disabled simply doesn't register.
**Validate in pilots:** p95 latency < 1.5s on 3G-class connections; per-card usefulness (tap-through + "was this useful" feedback) decides which cards keep their slot.

## D-3.2 — Freshness is a first-class display property; staleness is itself a signal

**Decision:** every card payload carries `computedAt` and, where derived from field input, `lastInputAt` per job (e.g., last daily report). The UI renders age ("as of 7:02", "no report since Tue") and a stale badge past a template-configured threshold. A job with no report for N working days surfaces *as an exception* (E-01, doc 04) on the owner/manager screens — absence of data is promoted to information, never hidden behind stale numbers.
**Why:** R18 (garbage-in destroys owner trust) is the product's most likely credibility failure; the mitigation is honesty in the chrome.
**Alternatives rejected:** silently showing last-known values (one wrong answer poisons the control-system claim); blocking cards until data is fresh (punishes the owner for the foreman's gap — backwards).
**Risks:** badge fatigue if thresholds are too tight — thresholds live in template config (doc 08 sets workshop-calibrated defaults), tunable per org.
**Validate in pilots:** owners can correctly answer "how current is this?" when asked during pilot calls; missing-report exceptions correlate with (and drive down) actual reporting gaps.

---

## Card specifications by role

Notation: **Card name** — contents · data contract (source queries / exception rules E-xx from doc 04) · primary tap action.

### Owner (desktop + phone; the thirteen-questions surface)

1. **Needs my decision** — pending approvals assigned to me (count + top items with amounts) and issues flagged `blocking` unassigned or assigned to me · approvals inbox query (doc 05) + issues query · tap → approvals inbox / issue.
2. **Jobs at risk** — jobs with open risk exceptions: overdue stage (E-02), margin drift (E-05), missing reports (E-01), stuck approvals (E-03) — grouped per job with reason chips · exception store filtered severity ≥ warning, audience `owner` · tap → job page, risk tab.
3. **Yesterday** — reports submitted (count/expected), stages completed, photo strip (6 most recent, **thumbnails only** per storage Appendix A — originals would destroy the p95 target), notable issues raised · daily-report + activity queries over previous working day · tap → daily reports list.
4. **Collections & receivables** *(renamed per audit C-12 — no bank data exists in the model)* — invoices overdue (count + total), invoices ready to issue (job `billing_points` reached, E-09), payments received this week, expenses awaiting approval · AR queries + costing rollups · tap → Money.
5. **This week** — stage transitions planned, jobs due, MRs awaiting delivery · week-view aggregate · tap → Work week view.
6. **Digest** — the AI-narrated morning digest (doc 04), collapsed to headline + expand · digest store · tap → full digest with evidence links.

Redaction: none — owner sees costs. Ordering fixed as above (decision-first). Card 6 collapses to a notification-only surface if the org disables AI narration.

### Manager / Workshop manager

1. **Today's plan** — stages/tasks active today across my jobs, grouped by job, with assignee avatars · tasks + stages where I'm manager · tap → week view.
2. **Blockers & issues** — open issues on my jobs by severity; unassigned first · issues query · tap → issue.
3. **Reports to review** — yesterday's reports awaiting my review, with anomaly chips from E-rules (e.g., labour hours outlier E-07) · report review queue · tap → report.
4. **Needs my decision** — approvals routed to manager rules · doc 05 inbox · tap → inbox.
5. **Stage gate** — stages awaiting completion confirmation (P3: awaiting QC) · stage-transition queue · tap → job stage.
6. **Missing today** — expected reports not yet in by the org's `report_cutoff_time` · **a plain capability query, not an exception rule** (audit C-7 — no lifecycle needed intra-day; nightly E-01 owns the exception) · tap → nudge action (one-tap reminder to foreman).

### Foreman (phone-first; ≤4 cards; one-thumb reach)

1. **My jobs today** — assigned jobs/stages with current status; big tap targets · assignments query · tap → job (field view).
2. **Submit daily report** — the primary action, rendered as a prominent button-card showing per-job done/not-done state for today; resumes drafts from the offline outbox · report-draft store · tap → report flow.
3. **My issues & tasks** — open items assigned to me, oldest first · tap → item.
4. **Waiting on me** — goods receipts to record for my jobs (a GRN-creation queue — **not** an approval, per audit C-2), reports **returned for correction** (the doc 01 `returned` state), and rejected MRs with reasons · tap → item.

No money data anywhere on this screen (doc 06 cost-visibility rule); no exception analytics beyond the user's own items — the foreman screen is for *doing*, not monitoring.

### Procurement

1. **Approved MRs to convert** — approved, not yet on a PO; aging shown · MR queue · tap → create PO flow.
2. **Open POs by expected date** — late highlighted (E-06 late supplier) · PO query · tap → PO.
3. **Receipts to record** — POs past expected date without goods receipt · tap → receive flow.
4. **Needs my input** — MR clarifications requested, approval questions · tap → item.
5. **Supplier watch** — suppliers with ≥N late deliveries in window (E-06 aggregate) · tap → supplier history.

### Accounts

1. **Invoices to issue** — jobs whose stage/billing milestones are reached without a corresponding invoice (E-09) · billing-point query · tap → create invoice (pre-filled from job state).
2. **Overdue receivables** — invoices past due, aged buckets · AR query · tap → invoice.
3. **Payments this week** — recorded receipts, running total · tap → payments.
4. **Expenses queue** — submitted expenses awaiting entry/approval, VAT flags · tap → expense.
5. **Job cost alerts** — jobs with cost anomalies (E-05 margin drift, E-08 unusual expense) *shown with amounts* — accounts role has cost visibility · tap → job costing page.

---

## Cross-cutting requirements

- **Data contracts are the analytics spec:** every card above names its source; doc 04 owns the E-rules; plain queries are owned by their capability. A card may not compute business logic client-side.
- **Notifications relationship:** cards are pull; doc 04 decides which state changes also push. The rule of thumb: push what needs action within hours (approval, blocking issue), digest the rest.
- **Acceptance test (from v2 §12):** with template #1 seeded and 2 weeks of pilot data, the owner answers all thirteen §5 questions from this screen live, unprompted. This test is scripted in doc 11 (slice S7 gate) with each question mapped to its card.
- **Instrumentation from day one:** per-card impressions, taps, dismissals, and feedback — the pilot's card-survival data (D-3.1) depends on it.
