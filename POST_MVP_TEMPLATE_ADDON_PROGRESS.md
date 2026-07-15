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

## Verified final state (2026-07-15, project close)

| Check | Result |
| --- | --- |
| Deployed + CI-green commit | `49ddb03` (health commit match; smoke 17/17; this docs update trails it) |
| origin/main | = local HEAD (all milestones pushed) |
| Migration ledger | **hosted 0000–0070 applied** (0065 addon · 0066 scans · 0067 sched-anchor · 0068 explicit trial_end · 0069 invite peek · 0070 honesty reclass) → next `0071` |
| Production orgs | ✅ exactly [Alpha Marine, TESTING] — untouched, byte-identical through every sweep + cleanup; `trial_end NULL` = no deadline **by 0068 contract** (regression-pinned) |
| Catalogue | 8 templates · 31 add-ons (19 purchasable, owner-ratified count for launch) · 6 bundles · free base plan |

## Work plan + status

| # | Phase | Status |
| --- | --- | --- |
| P-TA0 | Baseline verification + this tracker | ✅ |
| P-TA1 | Market research (17 products, official 2026 pages) + pricing rationale | ✅ (docs/commercial/* committed `04ae304`) |
| P-TA2 | Composable template architecture + 7 new templates | ✅ (`6b81974`; docs in `04ae304`) |
| P-TA3 | AI + deterministic template selection + onboarding UI | ✅ (`6b81974` core + `04ae304` UI: description, manual chooser, recommendation card, alternatives, limitations) |
| P-TA4 | Add-on catalogue + bundles + free base + entitlement extension | ✅ (`261b7ae` + `9194c23` + `04ae304`; migrations 0065–0067 applied hosted) |
| P-TA5 | UX (pricing page, EN/AR/RTL/375px) | ✅ (`04ae304` — subscription page rebuilt modular; honesty states; no payment buttons while disabled) |
| P-TA6 | Tests + full gates + CI | ✅ (unit 437/437 · integration 273/273 effective · CI green on 49ddb03) |
| P-TA7 | Adversarial review + fixes | ✅ (1 critical + 8 material fixed w/ regressions; 0069/0070) |
| P-TA8 | Deploy + demo + cleanup + report | ✅ (smoke 17/17 · demo 42/42 · baseline = 2 protected orgs; 1 pending approval) |

## Integration-test findings (both REAL source bugs — fixed with regression coverage)

1. **Seat recount SQL crash** — `any(${cls}::text[])` inlined a JS array as a record; every
   non-foreman invite under a finite limit threw `PostgresError`. Fixed with the repo's
   `string_to_array` idiom (`src/platform/auth/identity.ts`). Covered by the seat-limit test.
2. **Scheduled downgrades could defer forever** — the 0005 `touch_updated_at` trigger bumps
   `updated_at` on every later write, pushing the period-boundary math forward indefinitely.
   Fixed by **migration 0067**: immutable `org_plan_state.scheduled_plan_at` (trigger-stamped on
   the scheduling transition, explicit value wins, auto-cleared), scan + sweep use it
   (`updated_at` only as legacy fallback). Covered by the scheduled-downgrade sweep test.

Directive verifications all integration-asserted (tests/integration/addon-model.test.ts, 18/18):
catalogue⇔DB parity · free-plan resolution (3 seats, money caps off) · add-on/bundle resolution +
overlap never duplicates (one row per key, bundle price wins once) · deferred refused at BOTH the
service (AddonUnavailableError) and DB (`set_org_addon` raises) layers · webhook = sole org_addon
writer (idempotent duplicate, unverified never writes, tenant audit rows) · seat limits (foreman
never limited; seat pack lifts the wall) · FR-9 read-only outranks granted caps (suspended CREATE →
BillingReadOnlyError; recovery restores) · period-end removal sweep · scheduled-plan sweep ·
trial → free/active landing (never suspension; s9 lifecycle test updated accordingly) ·
downgrade deletes NOTHING (customer row survives; org_addon rows only flip status) ·
**protected orgs untouched by every sweep** (asserted in-suite).

## Ledger

- Local HEAD: `04ae304` + fixes to commit · Deployed: `97985e1` · Highest migration hosted: `0067` · Next: `0068`
- Tests: unit 29 files / 425 · addon-model 18/18 · s9-lifecycle+s9-subscription+entitlements+bleed+tenancy 37/37 · full integration bg-running
- CI: green on `f3d9380`; local milestone push pending full-suite green
- Review findings: adversarial workflow running; integration findings above already fixed
- Cleanup status: prod = 2 protected orgs only; addon-model test self-cleans (wipeOrgs)

## Exact next task

PROJECT COMPLETE. Final report: docs/POST_MVP_TEMPLATE_ADDON_COMPLETION.md. Deployed+CI-green
commit: 49ddb03 (this docs update lands as a trailing commit). Hosted migrations 0000-0070 (next
0071). Production baseline verified: exactly [Alpha Marine, TESTING], untouched. ONE PENDING
OWNER APPROVAL: deletion of 22 orphaned synthetic auth users (s5-/s6demo-/s9imp-/bleed-*
@example.com, zero org data; the real abdulla.alojan@gmail.com is excluded) — the destructive-
cleanup classifier paused it. Owner's evening testing instructions are in the completion report
§16. No further engineering until owner feedback.

## Resume instruction

Read docs/POST_MVP_TEMPLATE_ADDON_COMPLETION.md. If the owner approves the orphan-user deletion,
re-run the guarded removal (dry-run list is in the session transcript; filter: @example.com with
s5-/s6demo-/s9imp-/bleed- prefixes AND no membership). Never touch Alpha Marine / TESTING.
