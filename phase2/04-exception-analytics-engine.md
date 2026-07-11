# 04 — Operational Exception & Analytics Engine

**Purpose:** the deterministic layer that makes Today and the digest truthful (v2 §14: analytics first, AI narrates verified facts). It watches the operational event stream, raises **exceptions** when reality deviates from plan or rhythm, auto-resolves them when the condition clears, and assembles per-role digests.

---

## D-4.1 — Exceptions are materialized rows with lifecycle, not computed-on-read

**Decision:** an `exception` entity (org-scoped): `rule_key`, `severity (info|warning|critical)`, `job_id` (nullable — some rules are org-level), `subject_ref` (typed reference to the triggering record), `evidence_refs[]`, `raised_at`, `resolved_at`, `resolution (auto|dismissed|actioned)`, `audience_roles[]`, `dedup_key`. The evaluator upserts by `dedup_key` (rule + subject + period), so a persisting condition is one exception that ages, not a daily duplicate.
**Why:** materialization gives (a) an auditable history of what the system flagged and when — the trust substrate for later "AI noticed patterns" claims; (b) trend data (Improve step); (c) cheap Today/digest reads; (d) dismissal state per org.
**Alternatives rejected:** compute-on-read (no history, no dismissals, repeated heavy queries per screen view); building on a generic rules engine / workflow platform (banned direction — these are ~20 hand-written, unit-tested rule functions, not a DSL); LLM-evaluated conditions (non-deterministic, unexplainable, costs per evaluation).
**Risks:** stale exceptions if auto-resolve misses a clearing event — mitigated: every rule implements both `raise` and `clear` predicates and the nightly sweep re-evaluates all open exceptions from scratch (self-healing).
**Validate in pilots:** precision — % of raised exceptions rated "useful" ≥ 70%; anything below gets its threshold retuned or the rule cut. Noise kills this feature faster than absence would.

## D-4.2 — Evaluation is event-triggered where cheap, scheduled where not

**Decision:** two triggers. **Event-triggered** (via the domain-event bus → task-queue): rules whose subject is one record — stuck approval (on approval events + hourly age check), report submitted with anomaly, invoice issued/paid. **Scheduled** (nightly per org around org-local 03:00, **staggered via queue fan-out with concurrency caps and a per-org runtime budget** — all GCC tenants share UTC+3/+4, so unstaggered nightly sweeps herd; audit F-31): rhythm and aggregate rules — missing reports, overdue stages, margin drift, supplier lateness, aging AR. All aggregate math executes as **database-side SQL aggregates**, never paged row-shipping (audit F-30).
**Why:** intra-day responsiveness where users act within hours (approvals, blockers) without paying for continuous evaluation of aggregates that only change meaning daily.
**Alternatives rejected:** everything-on-cron (stuck approvals surface a day late — kills the Approve-step promise); everything-event-driven (margin drift would recompute on every expense line; wasteful and jittery).
**Risks:** clock/timezone/calendar bugs — the working calendar is a first-class org setting (doc 01) consumed by every date-math rule, with **country-aware defaults set at onboarding (UAE Mon–Fri, KSA Sun–Thu, 6-day workshop option — audit C-4)**, and every working-day rule also consumes the **org holiday calendar and Ramadan working-hours profile** (audit F-41 — without it, E-01 fires critical exceptions across every tenant during Eid, a synchronized trust-destroying noise event). Unit-test fixtures cover UAE, KSA, and 6-day calendars plus Eid and Ramadan windows explicitly.
**Validate in pilots:** approval-stuck exceptions appear within 1 evaluation hour; nightly run completes < 5 min/org at pilot data volumes.

---

## Exception rule catalogue (MVP unless marked)

Thresholds shown are **template #1 defaults** (doc 08); all are template/org-configurable (doc 09 schema) and stored per U6 (org currency minor units where monetary). Severity may escalate with age.

| Rule | Trigger/condition | Default threshold | Sev | Audience |
|---|---|---|---|---|
| E-01 missing daily report | active job in `production` phase, working day elapsed, no report | 1 day → warning; 3 consecutive → critical | W→C | manager, owner |
| E-02 overdue stage | stage end date passed, stage not complete | any; > 7 days → critical | W→C | manager, owner |
| E-03 stuck approval | approval pending beyond age | 8 working hours → warning; 3 days → critical | W→C | approver's role, owner |
| E-04 blocking issue unactioned | issue with `is_blocker = true` and no assignee or no activity (audit C-8 — "blocking" is the flag, not a severity value) | 4 working hours | W | manager, owner |
| E-05 margin drift | job cost/quoted ratio exceeds progress-adjusted expectation (quoted per C-10 precedence) | cost% − progress% > 15 points, or cost > 90% of quote while `isPreFinal` (audit C-11 — "pre-finishing" in template #1) | C | owner, accounts |
| E-06 late supplier | PO past expected date without receipt; aggregate: supplier ≥ 3 late in 90 days | any / 3 | W | procurement, owner (aggregate) |
| E-07 labour outlier | report labour hours per person outside plausible band | > 12h or 0h-with-work-lines | I | manager |
| E-08 unusual expense | expense amount > N× trailing median for its category on that job | 3× | W | accounts, owner |
| E-09 billing point reached | stage with billing milestone completed, no invoice within grace | 3 working days | W | accounts, owner |
| E-10 overdue invoice | invoice past due date unpaid | any; aged buckets | W→C | accounts, owner |
| E-11 quote-vs-actual variance *(P3 — deferred per audit F-20/§5; fires only at job completion, months away)* | job completed: final cost vs quote delta beyond band | ±10% | I | owner |
| E-12 idle crew *(P3 — deferred per audit F-14/F-20; derives from labour-line absence, not assignments)* | employee with no labour lines this week | — | I | manager |
| E-13 document expiry (people) | employee ID/visa expiring within window | 30 days | W | admin/owner |
| E-14 low stock vs active work *(P3, with Inventory)* | item below reorder point while referenced by active jobs' BOM | template | W | procurement |
| E-15 QC gate pending *(P3, with QC)* | stage complete-requested with open checklist items | any | W | manager |

Rules are versioned code with unit tests per rule (raise + clear + threshold edges). Adding a rule is a code release; tuning a threshold is tenant config. **No tenant-authored rule expressions in MVP** — that door stays closed until the automation builder (P4) per v1 §15 guardrails.

---

## Digest assembly

**Pipeline (per org, per role, each working morning; the evening owner edition is a pilot-phase nicety, deferred per audit F-20):**
1. Collect: open exceptions for the role's audience (new vs persisting flagged), yesterday's activity aggregates (reports in/expected, stages completed, approvals decided, money events), today's plan (from week view). **Per-role cost redaction (doc 06) applies at collection, before payload assembly** — the numbers-subset validator guarantees fidelity, not authorisation (audit F-23).
2. Rank: critical exceptions → decisions waiting → new information → plan. Cap: ~10 items; the rest collapse into counts.
3. Render **deterministic digest** — a fully templated, translated version that requires no AI and is always produced (this is also the AI-outage and credits-exhausted fallback).
4. **AI narration (Layer B):** the LLM receives the structured digest JSON only (no free tenant data trawling) and rewrites it as 4–8 natural sentences in the user's language, preserving every number and never adding facts — enforced by a validator that checks all numeric tokens in the output exist in the input (numbers-subset check) and by rendering evidence links from the structured source, not the prose.
5. Deliver: in-app digest card (doc 03), push notification headline, optional email. Interactions logged; "not useful" feedback feeds rule-precision review.

**D-4.3 — AI narrates a closed payload; it never queries.** Why: hallucination-proofing by construction (v2 §14 rules 1–4) — the narration cannot cite what it wasn't given, and the numbers-subset validator catches invention. Alternatives rejected: agentic "summarize yesterday" over raw tables (unbounded context, unexplainable, per-run cost). Risks: stilted prose from over-constrained input — acceptable; the fallback digest is already readable, narration is polish. Validate in pilots: narrated vs deterministic digest A/B on open-rate and usefulness; Arabic narration quality reviewed by native speakers.

**Customer progress drafts** (v2 §14, MVP) use the same closed-payload pattern: input = selected job's stage completions, progress %, curated photos, next milestones — **explicitly excluding** costs, internal issues, and other customers' anything; output = a client-appropriate update in the customer's language, saved as a draft the user edits and sends (send is always human).

**Delivery surface (audit F-22, adopted):** a sent update renders as a per-update page behind a **single-use ≥128-bit token** — org-revocable, expiring, `noindex`, rate-limited — embedding **watermarked derivatives only** (never originals, never long-lived signed URLs that leak via WhatsApp forwarding), containing only the safe-by-construction payload. PDF attachment is the alternative channel. This surface is in the pen-test scope (doc 10).

## Where AI is deliberately absent

Threshold evaluation, exception raising/clearing, money math, progress computation, digest fact-collection — all deterministic. This engine must work identically for a tenant with zero AI credits (v2 §13/§14: analytics are never credit-metered).
