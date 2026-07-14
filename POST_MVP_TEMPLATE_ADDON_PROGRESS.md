# Post-MVP Expansion — Template Catalogue + Modular Add-on Subscription Model

Anchor/progress doc for the post-MVP expansion project (NOT S12; S0–S11 historical scope unchanged).
Objective: (1) reusable industry template catalogue (7 new + marine preserved), (2) AI-assisted +
deterministic template selection in onboarding, (3) modular monthly add-on commercial model replacing
the fixed-plan *experience* by **extending** the existing plan/entitlement system, (4) all existing
security/tenancy/billing-state/provider-disabled guarantees preserved.

Hard rules: never modify Alpha Marine (`d22b2098-2e09-436d-ab9e-ee26c8719cd5`) or TESTING
(`9fcaa697-becd-41ec-97d4-6ce2851ead36`); no real payments; no card data; forward-only migrations
from `0065`; deferred capabilities never shown purchasable; prices are a recommended launch
catalogue (tax-exclusive USD/month), not a commitment.

## Verified baseline (2026-07-15)

| Check | Result |
| --- | --- |
| Local HEAD = origin/main | ✅ `f3d9380` (branch `main`, tree clean except FOUNDER_TEST_GUIDE.md to commit) |
| CI on HEAD | ✅ green (`CI` success on `f3d9380` and `97985e1`, via GitHub API) |
| Production health | ✅ ok — db 53ms, storage, queue 0 unprocessed; inngest unconfigured (known) |
| Deployed commit | `97985e1` (f3d9380 was docs-only and did not roll out; next deploy supersedes) |
| Migration ledger | `0000–0064` (65 files) → **next `0065`** |
| Production orgs | ✅ exactly [Alpha Marine, TESTING] (inventory script, read-only) |
| Template catalogue | 1 template: `boatbuilding_marine_v1` (TemplateManifest zod bundle; registry in `templates/boatbuilding.ts`) |
| Entitlement catalogue | 17 feature keys (11 `cap.*`, 6 `feat.*`) + 9 `limit.*`; plans starter/growth/business; DEFAULT_PLAN growth trial |
| Price book | `plan_price` (0052): versioned, per plan×interval×currency, `is_placeholder`, active-unique; AED+USD placeholder seeds |
| Billing writes | tenant-read-only `org_plan_state`; S9 DEFINER path sole writer; provider seam disabled in prod |

## Key architecture facts (drive the design)

- **Template = data manifest** validated by `TemplateManifestSchema` (terminology, stage_template,
  status_sets.job, category_sets{item,expense,quote_section}, reference_patterns, role_presets,
  presets≥1, holiday_calendars, field_definitions?) installed as a sequence of ordinary
  `applyConfigChange` revisions (each diffable/undoable). Structure-only by design — **no
  jobs/users/suppliers/transactions are seeded** (presets are *available models*, not created rows).
- **Entitlements** resolve plan → org overrides (60s TTL cache). `checkLimit` governs ADD only
  (FR-9: reads/exports never blocked). READ_ONLY_BILLING_STATES enforced at `command()`.
- **Add-on model direction**: extend with `addon_def` (stable keys) + `addon_price` (versioned, like
  plan_price) + `org_addon` (active add-ons, period-end scheduling) + `bundle_def`/`bundle_addon`
  (bundle = discounted collection resolving to the same addon keys — no separate entitlement system).
  Resolution order: base plan (free) → active add-ons (features OR, limits additive/max per key
  policy) → org overrides (highest precedence, preserved).

## Work plan + status

| # | Phase | Status |
| --- | --- | --- |
| P-TA0 | Baseline verification + this tracker | ✅ |
| P-TA1 | Market research (17 products, official 2026 pages) + pricing rationale | 🔄 data COLLECTED (23 agents, output on disk); docs pending |
| P-TA2 | Composable template architecture + 7 new templates | ✅ CODE (blocks + catalogue + 8 manifests + registry + terminology auto-derive); docs pending |
| P-TA3 | AI + deterministic template selection in onboarding | ✅ CORE (classify.ts + selectTemplate + proposal schema + validator; 8/8 scenarios green); UI pending |
| P-TA4 | Add-on catalogue + bundles + free base + entitlement extension (migrations 0065+) | ⏳ next |
| P-TA5 | UX (template chooser/preview/compare, pricing page, EN/AR/RTL/375px) | ⏳ |
| P-TA6 | Tests + full gates + CI | 🔄 unit green 410/410; integration/e2e at gate time |
| P-TA7 | Adversarial review + fixes | ⏳ |
| P-TA8 | Deploy + production demo + cleanup + final report | ⏳ |

## Current work

P-TA2/3 code milestone committed. Templates: boatbuilding preserved verbatim + 7 new manifests
(manufacturing, service, construction, food_beverage, online_store, agriculture, generic) built on
shared blocks; registry `templates/index.ts` drives pipeline/installer/terminology automatically.
Classifier: transparent scoring (keywords +3, phrase-overlap +2×ratio, MIN_SCORE 3 → generic
fallback, MIN_LEAD 2 → ambiguous), manual template_key override wins, alternatives + reasons carried
in the proposal, terminology.overrides artifact now APPLIES the founder's job term (fixes the
verified founder-test defect). Validator: registry membership + per-template privilege baseline.

## Ledger

- Local HEAD: (this commit) · Deployed: `97985e1` · Highest migration: `0064` · Next: `0065`
- Tests: unit 28 files / 410 passed; typecheck clean; lint pre-existing warnings only
- CI: green on `f3d9380` (pre-milestone); push deferred to next milestone
- Review findings: none yet (P-TA7 pending)
- Cleanup status: prod = 2 protected orgs only; no synthetic residue

## Exact next task

(1) Write docs: TEMPLATE_CATALOGUE.md, TEMPLATE_CONFIGURATION_REFERENCE.md,
AI_TEMPLATE_SELECTION_RULES.md, ADDON_MARKET_RESEARCH.md, ADDON_PRICING_RATIONALE.md (research data
in scratchpad task w7xycupwv.output). (2) P-TA4: migration 0065 (addon_def/addon_price/org_addon/
bundle_def/bundle_addon/bundle_price + free plan + app.set_org_addon DEFINER), addons.ts code
catalogue, resolver extension, seat-limit enforcement, capability gates, period-end sweep fix.
(3) P-TA5 UI. (4) Gates → review → deploy → demo → cleanup → report.

## Resume instruction

If interrupted: re-read this file; check background workflows `wf_d5674a04` (market research) and
`wf_dbc9b329` (code map) via their journals under
`~/.claude/projects/C--Users-abdul-Desktop-Bash/a51e3cf9-.../subagents/workflows/`; continue from
"Exact next task". All work on branch `main` of Desktop/idaraworks; migrations start at 0065;
never touch the two protected orgs.
