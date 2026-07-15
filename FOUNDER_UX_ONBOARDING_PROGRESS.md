# Founder UX & Onboarding Overhaul — Progress Tracker

New project (follows the completed Template Catalogue + Add-on Model). Scope: auth-callback fix,
pre-org onboarding journey (welcome → questionnaire → recommendation → proposal → subscription
selection [Free/Medium/High/Custom] → branding → review → explicit confirm → org+template →
dashboard), business-logo branding across UI+PDFs, full dashboard/navigation redesign
(role-aware), quality sweep, tests, adversarial review, deploy, demo, cleanup, report.

Hard rules: never modify Alpha Marine (`d22b2098…`) / TESTING (`9fcaa697…`) or use them for
tests; no real payments/card data; D1 stays closed; no second entitlement system (tiers =
governed bundles of the SAME add-on keys; Free = base entitlements); no template/paid entitlement
applied before the explicit final confirm; templates configure structure only; forward-only
migrations from **0071**; no raw i18n keys user-visible; EN/AR/RTL/375px everywhere.

## Verified baseline (project start, 2026-07-15)

| Check | Result |
| --- | --- |
| Local HEAD = origin/main | `845a172` (prev project closed; CI green on `49ddb03`, code-identical) |
| Deployed | `845a172`, health ok, smoke 17/17 |
| Migrations | hosted 0000–0070 → next `0071` |
| Production orgs | exactly [Alpha Marine, TESTING] — untouched |
| Pending owner approval | 22 orphaned synthetic auth users (deletion classifier-paused) |
| Confirmed defects | (1) confirm-email lands on `localhost:3000/?code=…` — signUp passes no emailRedirectTo, Supabase Site URL unset, root route never exchanges the code, /auth/callback is OAuth-only; (2) missing i18n key `today.screen.owner` renders raw; (3) first-login jumps into setup without a questionnaire; (4) dashboard = pale pill-wall (BottomNav built but unmounted; header overflows 375px) |
| Branding catalogue state | branding_docs/branding_app DEFERRED (0070) — this project implements the capability + enforcement and reactivates them honestly |
| PDF surfaces | LPO template only (`src/modules/supply/lpo-template.ts`, worker-rendered); quote/invoice PDFs do not exist yet — in scope via this directive |
| Auth-config reality | No Supabase management token/CLI → dashboard Site URL/allowlist is the ONE owner action; code will be made resilient (root `?code=` forwarding + request-origin emailRedirectTo) so fixing Site URL alone completes it |

## Work plan

| # | Phase | Status |
| --- | --- | --- |
| U0 | Baseline + tracker | ✅ |
| U1 | Auth-callback fix | ✅ (21 tests; prod origin never trusts headers; owner dashboard values documented) |
| U2 | Branding platform (0071) | ✅ (upload+enforcement+3 PDF templates; 19 unit + 12 integration) |
| U3 | Tier model (0072) + pricing components | ✅ (Medium $15 / High $39; zero missing i18n keys) |
| U4 | Pre-org onboarding flow (0073) | ✅ (19 questions, autosave/resume, explicit-confirm chain; 38+6 tests) |
| U5 | Dashboard + nav redesign | ✅ (sidebar/bottom-nav, 5 role screens, charts; 49 tests) |
| U6 | Quality sweep + founder e2e | ✅ (Arabic fixes, a11y, 3-profile Playwright spec, owner checklist) |
| U7 | Full gates + CI | ✅ (CI green on 78c6cae; smoke 17/17) |
| U8 | Adversarial review + fixes | ✅ (3 lenses: 1 security material + 15 design findings + honesty items — ALL fixed w/ regressions; password recovery shipped) |
| U9 | Deploy + demo + cleanup + report | ✅ (deployed 78c6cae; before/after evidence; targeted cleanup applied; report docs/ux/FOUNDER_UX_COMPLETION_REPORT.md) |

## Ledger

- Local HEAD `845a172` · deployed `845a172` · migrations 0000–0070 (next 0071)
- Tests at baseline: unit 437/437 · integration 273/273 · CI green (`49ddb03`)

## Exact next task

PROJECT COMPLETE. Final report: docs/ux/FOUNDER_UX_COMPLETION_REPORT.md. Deployed+CI-green:
78c6cae (this docs commit trails it). Hosted migrations 0000-0073 (next 0074). Production orgs:
[Alpha Marine, TESTING, Alhaash(REAL user org — untouched)]. Owner actions: (1) Supabase Site URL
(docs/ux/AUTH_CALLBACK_FIX.md); (2) optional: approve deletion of the 22 older orphaned test users.
Founder testing: docs/ux/FOUNDERS_TESTING_CHECKLIST.md.

## Resume instruction

Re-read this file + docs/POST_MVP_TEMPLATE_ADDON_COMPLETION.md. Check running agents/tasks first;
never restart completed waves. Migrations mint from 0071 upward (one agent per number). Protected
orgs untouched always.
