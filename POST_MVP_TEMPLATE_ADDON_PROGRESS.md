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

## Verified baseline (2026-07-15) — updated at the integration milestone

| Check | Result |
| --- | --- |
| Local HEAD | `04ae304` + working tree (integration tests + 2 source fixes + 0067, to commit) |
| origin/main | `f3d9380` (push happens at the deploy milestone) |
| Production health | ✅ ok; deployed commit still `97985e1`; inngest unconfigured (known) |
| Migration ledger | **hosted 0000–0067 applied** (0065 addon model, 0066 lifecycle scans, 0067 scheduled-plan anchor) → next `0068` |
| Production orgs | ✅ exactly [Alpha Marine, TESTING] — both growth/trialing/`trial_end NULL` (sweep provably can't touch them; integration-asserted) |
| Hosted seeds (0065) | 4 plans (free@0), 31 addon_def (5 deferred, 0 priced), 104 addon_price rows, 6 bundles, 40 free plan_entitlement rows |

## Work plan + status

| # | Phase | Status |
| --- | --- | --- |
| P-TA0 | Baseline verification + this tracker | ✅ |
| P-TA1 | Market research (17 products, official 2026 pages) + pricing rationale | ✅ (docs/commercial/* committed `04ae304`) |
| P-TA2 | Composable template architecture + 7 new templates | ✅ (`6b81974`; docs in `04ae304`) |
| P-TA3 | AI + deterministic template selection + onboarding UI | ✅ (`6b81974` core + `04ae304` UI: description, manual chooser, recommendation card, alternatives, limitations) |
| P-TA4 | Add-on catalogue + bundles + free base + entitlement extension | ✅ (`261b7ae` + `9194c23` + `04ae304`; migrations 0065–0067 applied hosted) |
| P-TA5 | UX (pricing page, EN/AR/RTL/375px) | ✅ (`04ae304` — subscription page rebuilt modular; honesty states; no payment buttons while disabled) |
| P-TA6 | Tests + full gates + CI | 🔄 unit 425/425 · addon-model integration **18/18** · affected suites 37/37 · FULL integration suite running (bg `bw8anfq2s`) · CI at push |
| P-TA7 | Adversarial review + fixes | 🔄 running (workflow `wf_9309768c`, 5 lenses + refutation) |
| P-TA8 | Deploy + production demo + cleanup + final report | ⏳ |

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

1. Read full-integration-suite result (bg `bw8anfq2s`) — fix any failure.
2. Read adversarial-review result (workflow `wf_9309768c`) — fix every confirmed material finding
   with regression coverage.
3. Commit fixes → full local gates (format/lint/typecheck/unit/build) → push → CI green on exact
   commit → Vercel serves it → production smoke.
4. Demo (fake-provider prod-backed script + deployed UI EN/AR/375px): 8 templates visible,
   deterministic recommendation per business type, manual override, explicit confirm before apply,
   ≥3 templates applied to separate synthetic orgs, free/add-ons/bundles/total, upgrade + scheduled
   downgrade, seat limit, provider-disabled checkout.
5. Guarded cleanup: dry-run first → pause for explicit approval if destructive → verify exactly
   [Alpha Marine, TESTING] remain → final report + evening onboarding-test instructions.

## Resume instruction

If interrupted: re-read this file; check bg task `bw8anfq2s` (full integration) and workflow
`wf_9309768c` (adversarial review) outputs under the session task/workflow dirs; continue from
"Exact next task". Branch `main` of Desktop/idaraworks; hosted migrations 0000–0067; never touch
the two protected orgs.
