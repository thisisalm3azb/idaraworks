# Founder UX & Onboarding Overhaul — Completion Report

**Status: COMPLETE.** Deployed, CI-green, smoke-verified, adversarially reviewed (3 lenses, every
confirmed finding fixed with regressions), cleaned up. All platform guarantees re-verified
(tenancy/RLS, redaction, billing-state sole writer, FR-9, no-hard-delete, provider-disabled, D1
closed, forward-only migrations, protected orgs untouched).

## 1. Authentication-callback defect and fix
Real prod defect: confirmation links landed on `localhost:3000/?code=…` ("refused to connect").
Root causes: `signUp` passed no `emailRedirectTo`; the Supabase Site URL was never set; the only
callback route was OAuth-only; nothing exchanged a `?code=` at the root. Fixed in code: request-
derived `emailRedirectTo` (production NEVER trusts forwarded headers — `APP_URL` ?? canonical
origin, a security-review hardening), a dual-purpose `/auth/callback` (email-confirm + OAuth +
password recovery) with open-redirect-proof `next` sanitizing, friendly already-confirmed/expired
handling, and middleware that forwards a root `?code=` to the callback — so correcting ONLY the
Supabase Site URL completes the fix. **One owner action remains:** Supabase → Auth → URL
Configuration → Site URL `https://idaraworks.vercel.app` (+ redirect allowlist; exact values in
`docs/ux/AUTH_CALLBACK_FIX.md`). Password recovery now exists (`/forgot` → email → `/reset-password`).
Coverage: 23 unit tests (origin, sanitizer ×7 attack vectors, error classification, routes, middleware).

## 2. Final onboarding sequence
Welcome → Business questionnaire → Template recommendation → Configuration proposal →
**Subscription selection (Free / Medium / High / Custom — explicit choice required)** → Branding →
Final review → **Explicit confirm** (the ONLY point where the org is created and the template
applied) → Dashboard (`?welcome=1`). Nothing is seeded (0 customers/jobs/suppliers/employees —
integration-asserted); no paid entitlement is ever activated by onboarding (tier recorded to
`app_settings` display-only). Autosave + resume (user-scoped `onboarding_draft`, migration 0073);
idempotent confirm with mid-chain resume. Full detail: `docs/ux/ONBOARDING_FLOW.md`.

## 3. Questionnaire — 19 questions, 5 grouped screens
Business (name, legal name opt., industry, own-words description) · Region (country, timezone,
currency, language — flips the flow locale live) · Scale (employees band, access-users band,
locations band, departments) · Work (patterns ×7, work intake, workflow text) · Needs (15
capability chips, device, customer sharing, main problem). Four documented skip rules (e.g. 1–5
employees skips seats+departments). Progress %, remaining estimate, back/next, help text,
EN/AR/RTL/375px, no ERP or boat language.

## 4. Template recommendation behaviour
Deterministic classifier over all 8 templates: recommendation + confidence badge (honest
"best guess" when ambiguous) + the influential answers + 2–3 scored alternatives + full catalogue
+ per-template preview + manual selection (always wins, end-to-end verified) + edit-answers loop.
AI never installs; proposals stay inside the validated schema; the AI provider seam remains an
unwired stub so deterministic IS the shipped path.

## 5. Free / Medium / High / Custom selection behaviour
Four comparison cards from the REAL catalogue (`buildSelectionView`): **Free $0** (3 office + 3
viewer seats, unlimited field logins, 10 active jobs, 1 GB — the 0065 definition verbatim);
**Medium $15/mo** (`bundle.tier_medium`: members_10, quotes_invoices, payments_ar,
expenses_cashbook, purchase_requests, purchase_orders — vs $28 individually, −46%);
**High $39/mo** (`bundle.tier_high`: 19 members incl. branding — vs $75, −48%, "includes all
currently available core features", never "everything"); **Custom** (grouped purchasable add-ons,
quantity steppers, live total; keys catalogue-validated server-side). Tiers are governed bundles of
the SAME add-on keys — no second entitlement system; overlap can never double-charge (PK-deduped,
integration-tested). No payment fields; D1 honesty statement on-screen; the recorded choice now
displays on the subscription page. Settings mutations got two-step confirms (cancel = danger
treatment). Docs: `docs/ux/SUBSCRIPTION_SELECTION_FLOW.md`.

## 6. Logo upload and storage
Drag-and-drop + tap upload; PNG/JPG/WebP only (SVG rejected outright); 2 MB cap, MIME +
magic-byte + dimension (32–2000px) validation on BOTH the settings path and the pre-org stash
(re-validated again at confirm); sharp re-encode to PNG (transparency kept, EXIF stripped, VC-4);
tenant-scoped storage, UUID filenames, no public write, authenticated reads only; accent colour,
display/legal name, footer details in one governed `org_branding` source (0071). Fallback:
initials avatar. Docs: `docs/ux/BRANDING_AND_LOGO.md`.

## 7. Logo locations (UI)
Sidebar brand slot (all pages), dashboard header, Settings → Branding preview — gated by
`feat.branding_app`. During the 14-day trial every placement is live; on Free it reverts to
initials (the wizard now discloses this honestly — review fix).

## 8. Branded PDFs verified
LPO, Quote (new template), Invoice — logo slot (aspect-preserved, contained, data-URI from
tenant-scoped storage only), org-name fallback, footer details with `dir="auto"` bidi isolation,
full esc() (incl. single quotes — review fix), gated by `feat.branding_docs`. Cross-tenant leakage
impossible by construction (unit-asserted). Rendering remains worker-gated (Inngest — credential-
gated add-on).

## 9. Dashboard redesign summary
Pale pill-wall replaced: branded left sidebar (org logo + name, role-aware groups: Today · Work ·
Materials · Money · Customers · People · Data · Settings, lock-vs-hide rule for gated modules),
top bar (quick-create, notifications, locale, account), mobile drawer + bottom nav (44px targets,
zero horizontal overflow), deeper canvas + elevation + org-accent tokens, hand-rolled accessible
SVG charts, skeletons, error boundary with retry, welcome banner. Interactive cards deep-link to
filtered views. Perf hardening from review: per-request `cache()` memoization + concurrent query
groups. Docs: `docs/ux/DASHBOARD_REDESIGN.md`, `docs/ux/ROLE_DASHBOARDS.md`.

## 10–13. Role dashboards
**Owner:** ops-health strip, KPI row (in-progress/completed/approvals/overdue), at-risk list,
receivables + revenue (price-gated), purchasing, attendance, exceptions, digest, subscription/usage
strip, quick actions, activity. **Manager:** workload by stage, assignments, overdue/blocked,
approval queue, reporting completion, shortages, deadlines. **Foreman (mobile-first):** assigned
jobs, submit-report CTA, tasks, materials, issues — zero money data (test-asserted under every
entitlement combination). **Accounts:** invoices, payments, AR aging donut, expenses, quotes
awaiting action, finance approvals. **Procurement:** MRs, approvals, open/overdue POs, awaiting
receipt, suppliers, exceptions. **Viewer:** real read-only Today (review fix — no more placeholder).

## 14. EN/AR/RTL/mobile results
1106/1106 key parity, zero missing keys, zero raw identifiers (e2e-asserted globally); ~330 new
Arabic strings reviewed by a reader (4 genuine defects fixed incl. an MT slip); logical CSS only
(grep-clean); charts are documented, consistent LTR number islands; 375px first-class (e2e
overflow asserts, 44px targets); pre-org language toggle added to login/signup/wizard.

## 15. Accessibility
Nav landmarks translated, aria-current, progressbar semantics, accessible swatch/stepper names,
alert/status roles on errors, chip focus-visible outlines, charts role=img + labels, WCAG-AA
token contrast, keyboard tooltips on trends.

## 16. Test results
Unit **590/590** (40 files). Hosted integration **295/295** (30 files) incl. new onboarding-draft
(6), branding (12), tier-selection, seat-accept, subscription-roundtrip; post-fix re-runs green.
Founder e2e spec (3 profiles + Arabic + 375px, screenshots wired) harness-integrated: 18 smoke
green, founder scenarios double-gated for local-stack runs. Format/lint/typecheck/build clean.

## 17. CI — **green on the exact deployed commit** (quality + integration jobs).

## 18. Final deployed commit — **`78c6cae`** (health-endpoint verified; smoke **17/17**; this
report lands as a trailing docs commit).

## 19. Migrations — hosted **0000–0073** (0071 org_branding + branding honesty reversal,
0072 tier bundles, 0073 onboarding_draft). **Next: 0074.**

## 20. Production baseline
**[Alpha Marine, TESTING, Alhaash]** — the two protected orgs (byte-stable, growth/trialing,
`trial_end NULL` = exempt by contract) **plus "Alhaash"**, a REAL org created through the deployed
app today (trial ends 2026-07-29) — almost certainly your own founder test; deliberately untouched.
7 leaked test-fixture orgs + 6 fixture users from today's integration runs were removed via a
name-verified targeted cleanup (dry-run evidence in-session). Still pending your approval from the
previous project: 22 older orphaned `@example.com` test users.

## 21. Founder testing instructions (tomorrow)
Use **`docs/ux/FOUNDERS_TESTING_CHECKLIST.md`** — the complete per-screen script with pass/fail
boxes. Short version: **(0) Owner action first:** set the Supabase Site URL (§1 above) so new
signups confirm cleanly. Then on your phone: register fresh at https://idaraworks.vercel.app/signup
→ confirm email (must return to the app, not localhost) → the wizard walks you through the 19
questions (try a restaurant; leave job-term blank once) → check the recommendation + change it →
pick a tier (try Medium) → upload your logo → review → confirm → the new dashboard. Switch to
العربية (toggle is now on the login page too), re-walk in RTL, and try `/forgot` for password
recovery. Expected-and-known: PDFs "pending" and no emails (Inngest/Resend unprovisioned),
purchases disabled (D1). Evidence: before/after screenshots in `docs/ux/evidence/`.
