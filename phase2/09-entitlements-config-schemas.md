# 09 — Entitlement Catalogue & Configuration Schemas

**Purpose:** (A) the concrete entitlement keys and tier hypotheses that make v1 §13's central entitlement service buildable; (B) the JSON-schema outlines every configuration artifact must validate against — the single write path (v1 §15) needs these as its law. Schemas are outlines: exact Zod definitions are S0/S1 build work, but shape and constraints are fixed here.

---

## A. Entitlement catalogue v1

**D-9.1 — Capabilities gate by feature key; scale gates by limit key; field seats are never limited.** Why: v2 differentiator 6 (honest economics) + D-6.3. Alternatives rejected: per-seat-everything (v1 research churn driver), usage-metering core workflows (Bubble/Glide failure pattern — taxing daily reports would tax the heartbeat). Risks: revenue concentration on few paid seats — pricing research (D3) owns that trade. Validate in pilots: price objections cluster on tier value, not on seat mechanics.

**Feature keys (capability gates):** `cap.jobs` (always on), `cap.daily_reports` (always on), `cap.issues`, `cap.approvals`, `cap.procurement` (MR/PO/GRN), `cap.quoting`, `cap.invoicing`, `cap.expenses_costing`, `cap.customers`, `cap.people`, `cap.customer_updates`, `cap.week_plan` — MVP set; P3+: `cap.inventory`, `cap.qc`, `cap.contracts`, `cap.assets`, `cap.api`, `cap.workflow_builder`, `cap.report_builder`, `cap.white_label`, `cap.multi_company`.
**Feature keys (behaviour):** `feat.ai_narration`, `feat.ai_drafts`, `feat.ai_onboarding` (always on, free — funnel), `feat.custom_fields`, `feat.org_terminology_overrides`, `feat.audit_export`, `feat.sso` (E-tier later).
**Limit keys:** `limit.full_users` (paid seats: Owner/Admin/Manager/Procurement/Accounts archetypes), `limit.field_users` (Foreman; Worker reserved for P3 — **null = unlimited on every tier**), **`limit.viewer_users` (free read-only class, unlimited — audit F-11)**, `limit.active_jobs`, `limit.storage_gb` (enforced per doc 01 Appendix A: transactional byte counter, warn 80%, block adds at 100%, never reads; **tier GB values flagged for D3 revisit — 25 GB Starter is ~6 months for a photo-heavy org even compressed**, audit F-36), `limit.ai_credits_month` (narration/drafts/conversation only — deterministic analytics never metered, D-4 rule), `limit.custom_fields_per_entity`, `limit.presets`, `limit.exception_rules_tuned` (soft).

**Trial abuse controls (audit F-26/F-27):** `feat.ai_onboarding` stays free but hard-capped per org (~30 LLM calls); per-IP/device signup throttle + disposable-email screening; platform-level daily AI spend circuit breaker; `trialing` orgs get the deterministic digest only (no narration) and a small storage quota with short signed-URL TTLs and per-org upload rate limits.

**Tier hypotheses** (numbers are placeholders pending D3 — *keys* are final):

| | Starter | Growth | Business |
|---|---|---|---|
| Full users / field users | 5 / ∞ | 15 / ∞ | 40 / ∞ |
| Active jobs | 10 | 40 | 150 |
| Capabilities | core loop (jobs→invoicing) | + inventory, QC, contracts *(as released)* | + API, builders, multi-company |
| AI credits/mo | small | standard | large |
| Storage | 25 GB | 100 GB | 500 GB |

Enforcement semantics unchanged from v1 §13: hard-stop for security-relevant features; soft-warn-then-block-adds for growth limits; **reads and exports never blocked**. Billing state machine, overrides/add-ons, resolution caching: v1 §13 verbatim.

## B. Configuration schema outlines

All artifacts: versioned (`schema_version`), org-scoped or template-scoped, written only via the validate→preview→revision pipeline (v1 §15), diffable. Common envelope: `{ schema_version, key, template_key?, org_id?, created_revision_id }`. **Every tenant-authored string value (labels, names, terms) passes the shared config-string sanitiser** (audit F-25): no markup, no ICU metacharacters, no leading `= + - @` (CSV formula injection); the export layer additionally quotes defensively, and tenant strings entering LLM payloads are delimited/attribute-quoted.

1. **TemplateManifest** — identity, object kind, included artifact refs (all below), capability set, min platform version. Constraint: every referenced artifact present and valid → template build fails otherwise (doc 07 tooling).
2. **TerminologyMap** — `{ [term_key ∈ closed catalog]: { [lang ∈ org languages]: { singular, plural, gender? } } }` (`dual` dropped per audit F-20); length caps + shared sanitiser (doc 07).
3. **StageTemplate** — ordered `[{ stage_key, names{lang}, weight ∈ 1..100, phase_semantic ∈ enum }]`; Σweights = 100; ≥1 stage; keys immutable once jobs reference them (renames allowed, deletes only via mapping migration — v1 §15 status discipline).
4. **StatusSet** — per entity type: `[{ status_key, labels{lang}, semantic_category ∈ enum, sort }]`; every semantic category reachable-or-explicitly-absent rules per entity (a job set must map to at least draft/active/done/cancelled).
5. **JobPreset** — code (pattern-safe), names, default_skipped_stage_keys ⊂ stage template, **default_billing_points `[{trigger: on_acceptance | stage_key, pct}]`, Σpct = 100** (audit F-1), quote_template_ref?, team_ref?, description.
6. **FieldDefinition** — entity_type ∈ registry, field_key (immutable), type ∈ {text, number, money, date, select(options), multiselect, boolean, photo}, labels{lang}, required?, visibility (roles), validation (per-type caps); per-entity count ≤ `limit.custom_fields_per_entity`.
7. **ApprovalRuleSet** — per subject_type ∈ doc 05 registry: `[{ condition: always | amount_gte(minor) | urgency_in[...], assigned_role ∈ org roles, auto_approve_below? }]`; validator rejects overlapping ambiguous conditions and unreachable rules at save time (doc 05 D-5.2).
8. **ExceptionThresholdSet** — `{ [rule_key ∈ E-catalogue]: { enabled, params{...}, severity_overrides? } }`; params typed per rule (doc 04); monetary params in org minor units (U6).
9. **TodayCardConfig** — per role preset: ordered `[{ card_key ∈ card registry, enabled, params? }]`; ≤ 6 owner cards (doc 03).
10. **CategorySet** — item/expense/quote-section lists with labels{lang}; expense categories carry `costing_mapping ∈ {job_materials, job_other, overhead}` (doc 08 — the mapping *is* the costing-spine config).
11. **ReferencePatternSet** — per document type: pattern string from a closed token grammar (`{preset_code} {seq:n} {year}` …), starting numbers (org-set).
12. **ConfigProposal** (Layer A output — v1 §14 step 3) — `{ intake_summary, template_key, artifacts: [subset of 1–11 as full documents], rationale_per_artifact, requires_upgrade: feature_keys[] }`; validated by every artifact schema above **plus** proposal-level rules: no permission grants beyond preset bounds, no capability outside entitlements (propose-as-upgrade instead), referential closure.
13. **RoleAssignmentPreset** — archetype ∈ doc 06, label{lang}, capability scoping toggles, `finance.viewCosts/viewPrices` flags.
14. **HolidayCalendar** (audit F-41) — country-seeded `[{ date | range, label{lang}, kind: public_holiday | eid | org }]` + Ramadan working-hours profile `{ range, daily_hours }`; org-editable; consumed by all working-day math.

**ConfigProposal safety addition (audit F-28):** AI-proposed `auto_approve_below` values are capped at 2× the template default; proposals exceeding the cap are rejected by the validator, not clamped silently.

**D-9.2 — Config keys are immutable; labels are mutable; deletes are mappings.** (stage_key, field_key, status_key, term_key). Why: history references keys forever (D-1.6 philosophy applied to config); Najolatech's deleted-stock-item lesson (`itemName` survives, link dies) generalised. Alternatives rejected: cascading renames (audit trail lies), free deletes (orphaned history). Risk: key clutter — retired keys hidden, not removed. Pilot validation: one mid-pilot reconfiguration per org (v2 §16 P2 gate) exercises rename + retire paths without data loss.
