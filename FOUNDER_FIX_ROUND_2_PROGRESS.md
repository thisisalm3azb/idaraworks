# Founder Fix Round 2 — Progress Tracker

Real founder test (org "The Business", created 2026-07-15 ~21:30Z through the deployed app) exposed
5 production defects: (1) subscription-selection page visually failed; (2) logo upload fails with a
generic message; (3) supplier creation fails ("Something went wrong"); (4) quick-create New menu
stays open and blocks the page; (5) post-onboarding Subscription page is a read-only catalogue —
no self-service management. Mandate: reproduce each in the DEPLOYED app first, fix at root with
regression coverage, then run a complete founder-flow regression before another founder test.

## Protected data (never modify/delete; never automated-test targets)

| Org | UUID | Baseline (2026-07-16) |
| --- | --- | --- |
| Alpha Marine | d22b2098-2e09-436d-ab9e-ee26c8719cd5 | growth / trialing / trial_end NULL |
| TESTING | 9fcaa697-becd-41ec-97d4-6ce2851ead36 | growth / trialing / trial_end NULL |
| Alhaash | 28503638-befd-4270-afc6-63254aeb9a22 | growth / trialing / trial_end 2026-07-29T09:35Z |
| The Business (founder's live test org — treat as real) | 83cdcac9-45f4-459b-8f7f-b9440b704449 | growth / trialing / trial_end 2026-07-29T21:30Z |

## Baseline

- Local HEAD = origin/main = deployed: `85f56e2` (health ok) · migrations 0000–0073 → next `0074`
- Unit 590/590 · integration 295/295 · CI green on `78c6cae` (code-identical)

## Plan

| # | Phase | Status |
| --- | --- | --- |
| R0 | Baseline + tracker + inventory | ✅ |
| R1 | Reproduce defects 2/3/4/5 in the DEPLOYED app (synthetic user+org, Playwright, real errors captured) | 🔄 |
| R2 | Root-cause fixes (4 agents: logo, master-data, menu, subscription redesign+management) + error-quality | ✅ committed `e66bf29` — unit 650/650, typecheck/lint/build clean; full hosted integration running |
| R3 | Complete founder-flow regression (3 synthetic orgs: construction, manufacturing, service/store) + error-message audit | ⏳ |
| R4 | Independent adversarial review (visual + security) + fixes | ✅ security CLEAN (governed auth/isolation) + visual: 1 MATERIAL (F1 onboarding tier grid crammed by max-w-2xl) + minors — ALL fixed w/ regressions |
| R5 | Gates + CI + deploy + production verification/evidence + guarded cleanup + final report | ⏳ |

## Reproduced defects / root causes (R1 — confirmed from deployed build 85f56e2 + code)

- **D2 logo upload** — ROOT CAUSE: `next.config.ts` `outputFileTracingIncludes` ships sharp's
  linux native libs (`@img/sharp-linux-x64`, `sharp-libvips-linux-x64`) only to `/api/inngest` and
  `/o/[orgId]/settings/branding`. The onboarding wizard's `uploadFlowLogoAction → stashDraftLogo →
  processLogo` runs in the **`/onboarding`** lambda, which lacks the libs → `ERR_DLOPEN_FAILED` →
  the action's catch returns `"failed"` → founder sees "The upload failed." No correlation id.
- **D3 supplier/master-data** — service `createSupplier`/`createCustomer` SUCCEED on a fresh org
  (verified against hosted DB); the page render is safe. The action `createSupplierAction` swallows
  any error into `redirect(?error=create_failed)` with no logging/correlation id, and "Something
  went wrong" matches the org error boundary. Needs live repro on a real org + error-quality
  hardening (correlation ids, specific messages, retain input) across suppliers/customers/items.
- **D4 New menu** — ROOT CAUSE: native `<details>/<summary>` popover (layout.tsx:134). Native
  `<details open>` never closes on outside-click, Escape, item-select, or client navigation, so the
  panel persists across route changes and overlaps content. Same for the account menu (:186).
- **D5 subscription read-only** — ROOT CAUSE: every management control (tier/bundle/add-on/cancel
  `ConfirmAction`) is gated on `canManage && view.providerEnabled`; prod `providerEnabled=false`
  (billing disabled) → zero controls → static catalogue. Fix = a governed test/trial path: enable
  management on `canManage`, record the governed change (recorded-choice / fake-provider-in-test),
  never activate real payment, honest "no payment collected" labelling.
- **D1 subscription visual** — narrow-column tier cards, add-ons in a long scroll below; redesign.

Reproduction assets: synthetic confirmed prod user `r2fix-b7e12ad0@example.com` (Admin-API created;
login verified). Evidence: docs/ux/evidence/r2-walk.txt, r2-supplier.txt.

## Exact next task

R1: seed a synthetic confirmed auth user (SQL, bcrypt password) → drive the DEPLOYED onboarding
with Playwright → capture logo-upload failure (network/server error, correlation id) → complete
onboarding → reproduce supplier-creation failure + New-menu behaviour + read-only subscription
page. Suspects to verify: sharp native binary missing in the (auth)/onboarding lambda (Vercel
trace includes were added only for the settings/branding route); masters create schema/normalization;
details/summary menu with no dismiss handling; manage controls hidden behind providerEnabled=false
in prod.

## Resume instruction

Re-read this file. Check running agents/tasks before starting anything. Migrations mint from 0074.
Never touch the four orgs above. Synthetic naming prefix for this round: "R2FIX-".
