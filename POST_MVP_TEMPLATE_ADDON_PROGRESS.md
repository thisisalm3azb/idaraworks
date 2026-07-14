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
| P-TA0 | Baseline verification + this tracker | ✅ done (this doc) |
| P-TA1 | Market research (17 products, official 2026 pages) + pricing rationale | 🔄 running (background research workflow `wf_d5674a04`) |
| P-TA2 | Composable template architecture + 7 new templates + docs | 🔄 design started (code-map workflow `wf_dbc9b329` feeding it) |
| P-TA3 | AI + deterministic template selection in onboarding | ⏳ |
| P-TA4 | Add-on catalogue + bundles + free base + entitlement extension (migrations 0065+) | ⏳ |
| P-TA5 | UX (template chooser/preview/compare, pricing page, EN/AR/RTL/375px) | ⏳ |
| P-TA6 | Tests + full gates + CI | ⏳ |
| P-TA7 | Adversarial review + fixes | ⏳ |
| P-TA8 | Deploy + production demo + cleanup + final report | ⏳ |

## Current work

Reading maps of billing/entitlement/config/test surfaces (4 parallel agents) + market research
(17 products + 3 thematic lenses + completeness critic) — both in background. Next: design doc for
the addon entitlement architecture + template shared-blocks library, then implement templates.

## Ledger

- Local HEAD: `f3d9380` · Deployed: `97985e1` · Highest migration: `0064` · Next: `0065`
- Test counts: (baseline from S11) full S0–S11 regression green in CI; exact counts re-recorded at P-TA6
- CI: green on `f3d9380`
- Review findings: none yet (P-TA7 pending)
- Cleanup status: prod = 2 protected orgs only; no synthetic residue (ai_interaction=2 rows belong to protected orgs)

## Exact next task

Consume the code-map workflow results → write `docs/commercial/ADDON_ENTITLEMENT_ARCHITECTURE.md`
(design) → implement template shared blocks + 7 manifests (P-TA2).

## Resume instruction

If interrupted: re-read this file; check background workflows `wf_d5674a04` (market research) and
`wf_dbc9b329` (code map) via their journals under
`~/.claude/projects/C--Users-abdul-Desktop-Bash/a51e3cf9-.../subagents/workflows/`; continue from
"Exact next task". All work on branch `main` of Desktop/idaraworks; migrations start at 0065;
never touch the two protected orgs.
