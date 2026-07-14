# S8 — AI Onboarding & Imports — Completion Report

**Status:** COMPLETE · deployed `6760e6e` (prod `/api/health` `commit=6760e6e` + 18/18 `smoke:prod`) · CI green (full integration on local Supabase + e2e) · Arabic DoD demo PASS · production baseline restored.
**Date:** 2026-07-14 · **Commits:** `e94edb8` (schema + pipeline + imports + UI + tests + demo), `6760e6e` (adversarial-review fixes) + docs follow-up.

## What shipped — "how does your business operate?" → configured workspace in ≤30 min

The Layer-A pipeline is deliberately a **validator around templates, not an agent** (doc 11 S8):
a structured intake grounds a **ConfigProposal** on template #1, every artifact is re-validated by
its S1 schema, and apply runs the governed `installTemplate` + config revisions — nothing bypasses
the config pipeline, and the whole flow works with **no AI credentials** (the manual fallback).

- **ConfigProposal artifact** (doc 09 #12): `{ intake_summary(en/ar), template_key, artifacts,
  approval_defaults, requires_upgrade }`, Zod-typed.
- **Grounded proposal builder** (`provider.ts`) — a deterministic, provider-seam builder mirroring
  the S7 narration adapter; the deterministic path IS the shipped product (onboarding is free +
  always-on). A future AI provider may only enrich prose, never widen config.
- **Validator** (`validate.ts`, pure): per-artifact S1 schema + proposal rules — (a) **F-28**:
  auto_approve_below capped at 2× the template default, **rejected (never clamped)** above the cap
  → the rejection-loop; (b) **no privilege grants beyond preset bounds** (a config.roles artifact
  may not raise a role's cost_privileged/price_privileged above the template baseline); (c)
  referential closure via the artifact schemas.
- **Pipeline** (`service.ts`): intake → ground → validate → persist `onboarding_session` → preview
  (`previewConfigChange`) → **apply-as-revision** (`installTemplate` + `applyConfigChange` with
  `aiFlag`, + F-28-capped approval-rule seeds) → **best-effort undo** (reverse the revisions,
  honouring D-9.2 config guards — the install marker reverts so the org returns to un-onboarded;
  irreversible custom fields are retained). Every mutation is `command()`+audit.
- **Trial-abuse controls** (doc 10 #32 / F-26): each proposal generation is METERED into
  `ai_interaction (feature='config_proposal')` and hard-capped per org via
  `limit.ai_onboarding_calls`; a platform daily AI-spend **circuit breaker** (SECURITY DEFINER
  cross-org aggregate) guards the metered surface.
- **Guided CSV imports** (`imports/service.ts`): customers / employees / items — stage → per-row
  schema-validate (same masters schema as the manual form) → apply through the governed
  `createCustomer/Employee/Item` (identical validation + audit + RLS) with a per-row **atomic claim**
  so a double-submit can't duplicate rows; forgiving header aliases; re-runnable.
- **First-run + UI** (en/ar/RTL/375px): the onboarding **intake questionnaire**, the **preview
  screen** ("best screen in the app"), the **import wizard**, and a seeded **onboarding checklist**
  on the owner Today when no template is installed.
- **Platform wiring:** authz `onboarding.run` (owner/admin) + `imports.manage` (owner/admin/manager)
  in BOTH matrix transcriptions; `AUDIT_ENTITY_TYPES` += onboarding_session, import_batch; entitlement
  catalogue += `limit.ai_onboarding_calls`; bleed seeders for the 3 new tables.

## Migrations (hosted Seoul DB now at 0000–0051)

- `0050` onboarding_session, import_batch(+import_row), widen `ai_interaction.feature` for
  'config_proposal', entitlement `limit.ai_onboarding_calls` (per-org onboarding-call cap).
- `0051` **review-fix**: SECURITY DEFINER `app.platform_daily_ai_spend()` so the circuit breaker's
  cross-org aggregate isn't RLS-zeroed (it was fail-open as a bare app_user read).

## Adversarial review — 3-lens, all confirmed material findings fixed + regression-covered

| Sev | Defect | Fix | Regression |
|-----|--------|-----|-----------|
| MATERIAL | approval-rule seeding INVERTED — `amount_gte(X)` never auto-approves below X (friction inverted) | seed an `always` rule carrying `auto_approve_below_minor = X` (the S4 engine's real mechanism) | S8 integ (2 always-rules w/ auto_approve_below) |
| MATERIAL (latent) | platform AI-spend circuit breaker fail-OPEN — RLS zeroes a bare app_user cross-org sum | migration 0051 SECURITY DEFINER aggregate | — (deterministic spends 0; live for a real provider) |
| false-assurance | validator rule (b) DEAD — read a non-existent `role_presets.actions` field → empty set | bound the real grant vector: no raising cost/price_privileged above template baseline | S8 unit (cost_privileged raise rejected) |
| MINOR | `applyImport` double-apply race could duplicate masters rows | per-row atomic claim (guarded valid→applied UPDATE before create) | covered by import integ + design |
| stale | `assertEntitlementClosure` referenced in a comment (no such fn) | comment corrected — requires_upgrade is informational; onboarding never applies a capability | — |

Verified sound (no defect): undo marker-revert guarantee, the onboarding-call cap (no off-by-one),
requires_upgrade computation, tenant isolation + RLS/grants (no DELETE grants, D-1.7), authz-matrix
parity, server-action ctx re-resolution, import authz (every imports.manage holder holds the masters
.manage it delegates to). Documented non-blocking gap: the intake job-term is recorded but a
terminology OVERRIDE is not applied (terminology.overrides is not a config-pipeline handler; the
marine template's terms already match the intake default).

## Gates

format ✓ · lint 0 errors ✓ · typecheck ✓ · **unit 282/282** (incl. 9 S8: builder determinism,
requires_upgrade, F-28 reject/rejection-loop, no-privilege-raise, duplicate/malformed) · build ✓
(S8 routes present) · **S8 hosted integration 5/5** (cold→configured, **PARITY 290000/395000**,
guided import, call-cap, guard-respecting undo — vs the real Seoul DB) · **full integration + e2e
green on GitHub CI** (local ephemeral Supabase; migrate incl. 0050+0051) · deployed commit confirmed.

## Production DoD demo (Arabic, `tooling/scripts/s8-prod-demo.ts`)

Synthetic Arabic org **ورشة الإعداد** (Alpha Marine + TESTING never touched), against the production DB:

- **cold org** (no template) → `startOnboarding` → `applyOnboarding`: template installed (**20 config
  revisions**) + **2 `always` approval rules** carrying auto_approve_below ("0 amount_gte" confirms the
  review fix).
- a real **first job** (24C-001 قارب التجربة) created under the onboarded preset.
- **PARITY: ex-labour = 290000, total = 395000 → MATCH** (the onboarded config reproduces the S5
  costing golden to the minor unit — doc 08 gate).
- **guided import**: 2 rows staged (1 valid, 1 invalid) → **1 customer** created through the governed service.
- **onboarding-call cap**: a further proposal **blocked** after the cap.
- **undo**: 18 revisions reverted, template uninstalled (org returns to un-onboarded).
- **DoD: PASS**; self-cleanup left **0** org rows.

Post-close, the guarded cleanup removed the 4 `S8 Org` integration leftovers + the demo org (5 orgs +
5 users + 495 rows); `s7-inventory.ts` confirms **orgs = 2 (Alpha Marine, TESTING)**, S7 **and** S8
tables all 0 (onboarding_session / import_batch / import_row / ai_interaction config_proposal = 0),
prod health green on `6760e6e`. Pre/post baseline matches.

## Owner actions from S8 (documented, non-blocking)

- **AI onboarding/enrichment provider** — none is wired; onboarding runs on the deterministic
  grounding (the shipped product). `feat.ai_onboarding` is free + always-on.
- Carried from earlier slices: Inngest keys, production PDF runtime, e-invoice partner,
  payment-provider creds, Sentry DSN, Upstash, password rotation, delete junk Vercel projects.

## Alpha Marine & TESTING

Never read for deletion or written by S8 build, tests, or demo. Only S8 synthetic data (the demo
org + the `S8 Org` integration leftover) is removed at close; pre/post baseline = [Alpha Marine, TESTING].
