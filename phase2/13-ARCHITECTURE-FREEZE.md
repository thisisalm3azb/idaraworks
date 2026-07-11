# 13 — Architecture Freeze

**Status:** 🧊 FROZEN · July 2026 · Owner accepted the audit's CONDITIONAL GO; all audit amendments applied (docs 00–11).
**Effect:** the strategy phase is closed. No further strategy documents will be produced. All work from this point is implementation, governed by doc 11 (the engineering implementation plan) and `../BUILD_BIBLE.md` (the engineering constitution).

## Change-control rule

A frozen decision may be changed **only** with one of three justifications, recorded as a dated amendment to this document:

1. **A verified security issue** — demonstrated, not hypothetical (a failing test, a pen-test finding, a disclosed vulnerability).
2. **A proven scalability or reliability issue** — measured against the doc 11 performance budgets or production telemetry, not predicted.
3. **Evidence from real pilot customers** — observed behaviour or explicit feedback from paying/piloting companies, not internal preference.

"A better idea," "a competitor shipped X," and "while we're in there" are explicitly **not** justifications. Anyone (human or AI agent) proposing a change must cite the justification class, the evidence, and the blast radius, and the owner approves in writing. Open decisions (§3) are exempt — they close through their stated mechanisms.

## 1. Frozen — architecture

| # | Decision | Source |
|---|---|---|
| FR-1 | Category: **Operations Management System**; the job and its operational event stream are the centre; never ERP, departmental suite, no-code builder, or generic workflow platform | v2 §2, §7 |
| FR-2 | Operational loop (Plan→Assign→Supply→Execute→Report→Inspect→Approve→Measure→Bill→Improve) as the organising model; **the daily report is the heartbeat**; Approve is the owner's lever | v2 §7 |
| FR-3 | One concrete operational object: **`job`** (kind `project`), with extension points E1–E5 and **no universal engine before a second paying vertical**; new object kinds only via the §8.3 rule; customers never get an object-type designer | v2 §8, U1, D11 |
| FR-4 | Six-layer architecture with the execution engine at the centre; L2 depends only on L1; finance is a view over operations | v2 §9 |
| FR-5 | Stack: Next.js + TypeScript + Supabase/Postgres + Vercel as a **modular monolith** with enforced boundaries; all data access server-side; RLS as second wall via the doc 10 #1 GUC mechanism; one migration-driven schema for all tenants | v1 §9–10, F-21 |
| FR-6 | Pooled multi-tenancy: org_id everywhere, five-layer enforcement, UUIDv7, the doc 10 checklist (1–51) as law | v1 §11, doc 10 |
| FR-7 | Configured-not-customised: all tenant differences are validated config data through one write path (validate→preview→revision→undo); config keys immutable; no tenant code, DDL, or rule expressions | v1 §15, doc 09 |
| FR-8 | AI: Layer A configures via validated proposals (never code/DDL/permissions beyond presets); Layer B is read-first, analytics-backed, evidence-linked, closed-payload narration; AI never autonomously executes financial, contractual, employment, or security actions; deterministic analytics never credit-metered | v2 §14, doc 04 |
| FR-9 | Central entitlement service; plans as data; no `if (plan===…)` in code; reads/exports never blocked; field & viewer seats free-class | v1 §13, doc 09 |
| FR-10 | Money: integer minor units, single org currency (MVP), recorded-not-assumed VAT, ex-VAT costing basis for registered orgs (pending PB-3 sign-off), derived-not-stored with frozen snapshots + audited overrides, void-never-delete, credit-notes for post-clearance corrections, the F-2 costing dedup rule | doc 01 |
| FR-11 | Unified approval engine (closed registry, single-approver + threshold rules, self-approval guard); no chains before P4 | doc 05 |
| FR-12 | Exception engine: materialized rows, deterministic raise/clear, template thresholds, holiday/Ramadan-aware working-day math, staggered nightly + event triggers, DB-side aggregates | doc 04 |
| FR-13 | Terminology layer (closed key catalogue, template→org→language resolution, `latn` numerals default); renameable = domain nouns only | doc 07 |
| FR-14 | Storage: doc 01 Appendix A (compression, EXIF strip, derivatives, access classes, quotas, replication, legal-hold coverage) | F-34…F-38 |
| FR-15 | Retention: doc 01 Appendix B, incl. financial audit rows ≥ 6 years | F-39 |
| FR-16 | Accounting: integrate/export, never build a GL; e-invoicing via certified partner behind the `einvoice_submission` seam | v1 P8, D4 |
| FR-17 | PWA-first; offline-*tolerant* not offline-first; MVP outbox = daily reports + photos only; nothing requires a socket | v1 §9, audit §5 |

## 2. Frozen — MVP product scope

| # | Decision |
|---|---|
| FS-1 | **In scope:** doc 11's slice contents, exactly — platform bedrock; template #1 (Boat Building & Marine Fabrication) only; jobs/stages/tasks/crew; daily reports + issues + attendance-via-labour-lines; approvals + MR→PO→GRN; expenses + costing + Today screens (5 roles); quotes (+revisions) → invoices (+credit notes, e-invoice seam, bilingual PDF) → payments + AR; exceptions E-01…E-10 + E-13 + digest + customer-update drafts with share surface; AI onboarding (Layer A); imports; billing; hardening. |
| FS-2 | **Out of scope until their stated phase** (the doc 11 scope-guard list): GL, payroll, inventory stock levels, QC, builders, API, multi-company, white-label, WhatsApp, Worker archetype, week_plan, insight, branch, date-ranged assignments, templates #2–3, E-11/E-12, change orders (price adjustments suffice), offline approvals. Adding any of these to MVP requires the change-control rule. |
| FS-3 | **Pilot design:** 5–10 GCC companies; Najolatech = tenant #1, test bench, template source — never PMF proof; ≥2 arm's-length non-marine pilots; pilots pay from month 2; success metrics per v2 §12 + doc 11 gates. |
| FS-4 | Market entry: project-based industrial SMBs, GCC-first, Arabic+English. This is entry strategy, not platform ceiling — but no non-entry work before P4. |

## 3. Intentionally open (close via stated mechanism, not change control)

| # | Open decision | Closes via | Deadline |
|---|---|---|---|
| OP-1 | Incorporation & merchant of record (D1) | Legal/tax advice | Before S9 (open the process at S0) |
| OP-2 | Pricing numbers & tier limit values (D3) | Owner's pricing research | Before pilot invoicing |
| OP-3 | E-invoicing partner (D4) + per-country pilot compliance stance | Partner quotes/sandbox | Before S6 |
| OP-4 | Product name clearance (D2′ — IdaraWorks) | Trademark/domain/AR-connotation check | Before pilot branding |
| OP-5 | PB-3: ex-VAT costing sign-off | Pilot accountant session (schedule at S4) | Before S5 golden files |
| OP-6 | PB-7: field auth — phone-OTP vs admin-issued | Owner (knows his foremen) + SMS provider | Before S0 completes |
| OP-7 | PB-8: payment_receipt approval ritual on/off in template #1 | Owner preference | Before S6 |
| OP-8 | PB-9: AED-only quoting acceptable for pilots? | Owner confirms; else per-document display currency specced pre-S6 | Before S6 |
| OP-9 | PB-6: capacity — two builders vs one + S8/S9 deferral variant | Owner decision (v1 Q10 answered honestly) | **Before S0 starts** |
| OP-10 | Today card composition per role | Pilot per-card telemetry (cards may be re-ordered/swapped without change control; the *composer architecture* is frozen) | P2 |
| OP-11 | Exception thresholds & digest tuning | Pilot precision data (≥70% useful) | P2 |
| OP-12 | D14 digest channel (WhatsApp) | Pilot behaviour if Today engagement lags | P2/P3 |
| OP-13 | Second operational-object kind & timing (D13) | The frozen §8.3 rule: committed paying pilots of a template that cannot express its work as job+stages+tasks | P4 gate |
| OP-14 | Storage tier GB values | With OP-2 pricing research (audit F-36) | Before pilot invoicing |

## 4. Amendment log

| Date | Change | Justification class | Evidence | Approved |
|---|---|---|---|---|
| 2026-07-11 | **OP-9 CLOSED:** implementation by one human + Claude Code as AI development partner — single implementation stream; AI reviewer agents for code review, testing, security review, verification. No parallel human teams assumed. Doc 11 estimates stay in builder-weeks; calendar = single stream. | Open-decision closure | Owner decision | Owner |
| 2026-07-11 | **OP-6 CLOSED:** default auth = email + password; **phone + OTP is a per-org optional setting** (org enables/disables independently). TOTP MFA unchanged. | Open-decision closure | Owner decision | Owner |
| 2026-07-11 | **OP-7 CLOSED (supersedes PB-8):** payment approval is org-configurable via the approval engine's existing rule vocabulary — modes: **none** (no rule) / **every payment** (`always`) / **above threshold** (`amount_gte`). Approvable subject is `payment`; `payment_receipt` remains the printable wrapper with no separate approval. Configuration, not code branching (doc 05 amended). | Open-decision closure | Owner decision | Owner |
| 2026-07-11 | **OP-8 CLOSED — amends FR-10's "single org currency (MVP)":** MVP supports **AED, SAR, QAR, KWD, BHD, OMR, USD, EUR**. One org **base accounting currency**; quotes/invoices (and their payments) may use any enabled currency; every financial document stores its **exchange rate at issuance** (immutable — historical values never change, the frozen-snapshot pattern); **costing, reporting, AR and exceptions always operate in base currency** via base-amounts frozen at issuance. Minor units are currency-aware (**KWD/BHD/OMR have exponent 3**). Rates: manual per document with an org-editable default table; no external FX API and no FX gain/loss modelling in MVP. Doc 01 D-1.3 amended; S6 effort +~1 bw. | Open-decision closure (OP-8 explicitly reserved this) | Owner decision | Owner |
| 2026-07-11 | **PB-5/OP-12-adjacent CLOSED:** customer progress delivered as **both** the secure revocable web link (doc 04 token surface) **and** downloadable PDF. | Open-decision closure | Owner decision | Owner |
| 2026-07-11 | **Billing points confirmed:** fully editable per job; templates/presets provide defaults only — exactly as F-1 specified; no spec change needed. | Confirmation | Owner decision | Owner |

**§3 status note:** OP-6, OP-7, OP-8, OP-9 and the PB-5 channel question are **closed** per the log above. Still open: OP-1 (incorporation — start at S0), OP-2/OP-14 (pricing + tier values), OP-3 (e-invoice partner, by S6), OP-4 (name check), OP-5 (ex-VAT accountant sign-off, by S5), OP-10/11 (pilot tuning), OP-12 (WhatsApp channel), OP-13 (second object kind).
