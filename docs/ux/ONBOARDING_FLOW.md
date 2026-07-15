# Onboarding Flow — the Pre-Org First-Login Journey (U4)

> Status: shipped with migration **0073** (`onboarding_draft`). Replaces the old
> one-card create-org form at `/onboarding`. The org-scoped intake at
> `/o/[orgId]/onboarding` remains for already-created orgs; this flow reuses its
> pipeline programmatically (`startOnboarding`/`applyOnboarding`) at confirm
> time — nothing was rebuilt.

## 1. The sequence

```
Welcome → Business → Region → Scale → Work → Needs
        → Template recommendation → Configuration proposal
        → Subscription selection (Free / Medium / High / Custom)
        → Branding (skippable) → Review → EXPLICIT CONFIRM
        → org creation + template application → /o/<orgId>?welcome=1
```

Eleven screens (`FLOW_STEPS` in `src/modules/onboarding/flow.ts`), one route
(`/onboarding?step=<step>` — deep-linkable), a progress bar (% + remaining-step
estimate) on every screen after Welcome. Everything before the final confirm is
a DRAFT: **nothing is created, applied, granted or charged until the founder
presses the confirm button on the review screen.**

## 2. Storage: one draft per user (migration 0073)

`onboarding_draft` — `user_id` PK/FK `auth.users`, `data` jsonb (answers,
chosen template, tier selection, branding stash, confirm progress), `step`,
`status ∈ (active, completed)`, touch-triggered `updated_at`. **USER-scoped
RLS** (`user_id = app.current_user_id()` — the user_profile idiom; the flow
runs under `withUserCtx`, no org GUC exists yet). Grants: select/insert/update,
**no DELETE** (D-1.7) — completion flips `status`; a later flow re-activates
the same row.

**Autosave + resume:** every step submit upserts the whole draft and advances
the saved step. Refresh, logout/login, or another device resume at the saved
step (`resolveLanding`: no-org user with an active draft → their step;
brand-new user → Welcome). `?step=` deep links are clamped to the first
incomplete screen so half-finished answers can't be skipped past. Users who
already have an org — invite acceptors included — are redirected to the org
and never see this flow (single exception in §6).

## 3. The questions (19, grouped one topic per screen)

| # | Screen | Question | Field | Notes |
|---|---|---|---|---|
| 1 | Business | Business name | `business_name` | required |
| 2 | Business | Registered legal name | `legal_name` | optional |
| 3 | Business | What field do you work in? | `industry` | select: construction, marine, manufacturing, field_services, food_beverage, retail_online, agriculture, other |
| 4 | Business | Describe what you do, in your own words | `business_description` | textarea, feeds the classifier |
| 5 | Region | Country | `country` | AE/SA/KW/BH/OM/QA (the intake schema's supported set) |
| 6 | Region | Time zone | `timezone` | defaulted per country |
| 7 | Region | Main currency | `base_currency` | defaulted per country; the org table's allowed set |
| 8 | Region | Preferred language | `preferred_language` | en/ar — flips the flow locale immediately (locale cookie + user_profile.locale) |
| 9 | Scale | How many people work in the business? | `employees_band` | 1-5 / 6-20 / 21-50 / 51-200 / 200+ |
| 10 | Scale | How many will need to sign in? | `users_band` | 1-3 / 4-10 / 11-25 / 26+ — SKIP-1 |
| 11 | Scale | How many locations or branches? | `locations_band` | 1 / 2-3 / 4-10 / 10+ |
| 12 | Scale | Which areas exist in your business? | `departments` | chips, optional — SKIP-2 |
| 13 | Work | How does your work usually happen? | `work_patterns` | multi: project/order/service/recurring/retail/production/mixed |
| 14 | Work | How does new work usually reach you? | `work_intake` | chips, optional |
| 15 | Work | How does a typical piece of work move from start to done? | `workflow_description` | short text, optional — SKIP-3 |
| 16 | Needs | What would you like to manage here? | `capabilities` | chips over: assignments, stages, daily reports, inspections, issues, approvals, purchasing, inventory, receiving, costing, quotes, invoices, payments, customer updates, exports |
| 17 | Needs | Where will your team mostly use it? | `device` | desktop / mobile / both |
| 18 | Needs | Will you share progress updates with your customers? | `customer_sharing` | y/n — SKIP-4 |
| 19 | Needs | What's the main problem you want to solve? | `main_problem` | textarea, optional |

Help texts carry examples that never force an answer; wording is neutral (no
ERP jargon, no domain nouns — the domain-noun i18n test covers the catalog).
All strings live in the `onboarding.flow.*` block of `en.json`/`ar.json`
(201 keys each); RTL and 375 px layouts follow the platform primitives.

**Not asked (deliberate):** VAT registration and the 6-day working week. They
default (not VAT-registered, 5-day week) at confirm and stay editable in
Settings — the questionnaire stays short and non-financial.

### Skip rules (question-level; enforced in `applyStepAnswers`, mirrored visually with CSS `:has()`)

- **SKIP-1** — `users_band` is not asked when `employees_band = 1-5`; the
  smallest band (`1-3`) is derived at intake time, never stored.
- **SKIP-2** — `departments` is not asked when `employees_band = 1-5`.
- **SKIP-3** — `workflow_description` is only asked when at least one chosen
  work pattern has a start-to-finish flow (retail/recurring alone don't).
- **SKIP-4** — `customer_sharing` is only asked when a customer-facing
  capability (quotes / invoices / customer updates) was picked; skipped =
  `false` derived.

A skipped question's stale answer is **dropped on submit**, so the review never
shows an answer the founder no longer gave. Unit-tested as a matrix in
`tests/unit/onboarding-flow.test.ts`.

## 4. Classifier mapping (the recommendation step)

The EXISTING deterministic classifier (`classify.ts`) is untouched. The flow
only composes its input text (`buildClassifierText`): the founder's own words
first (`business_description`, `workflow_description`), then honest hints —
industry (`INDUSTRY_HINTS`, e.g. field_services → "maintenance repair field
service"), work patterns (`PATTERN_HINTS`, e.g. order → "made to order"), and
four light capability hints (purchasing/inventory/receiving/costing). Capped at
the intake schema's 600 chars; the business name is appended by
`selectTemplate` itself as before.

The template screen shows: the recommendation with match score + confidence
badge (ambiguous/generic ⇒ "best guess — please review"), the WHY (the
classifier's matched signals, verbatim via the existing `selectTemplate`
reasons), the top-3 scored alternatives with full previews (stages,
terminology, honest limitations from the catalogue entry), a collapsible list
of every remaining template — **all 8 are always reachable** — manual
selection, and "edit my answers" back-navigation. Scenario coverage (8
canonical + mixed retail/service + mixed manufacturing/service) in
`tests/unit/onboarding-flow-mapping.test.ts`.

## 5. Proposal, subscription, branding

- **Proposal** — `draftToIntake` builds the exact S8 `OnboardingIntake`;
  `buildGroundedProposal` + `validateProposal` run PURE (no org, no session,
  no ctx — they always were pure; nothing is persisted here). The screen shows
  stages, terminology (with editable job terms — **typed-vs-blank law**: blank
  keeps the template's own word, typed becomes a `terminology.overrides`
  artifact at apply), role presets, and the honest approvals note (no rules
  are auto-seeded; this flow asks no thresholds).
- **Subscription** — embeds `buildSelectionView()` + `<TierCards>` +
  `<CustomBuilder>` per docs/ux/SUBSCRIPTION_SELECTION_FLOW.md §4. **No
  default pre-selection; the only way forward is an explicit choice** (Free is
  one honest click on its own card). The draft records
  `{mode: free|tier_medium|tier_high|custom, customKeys?, quantities?}`. No
  payment fields exist anywhere in the flow.
- **Branding** — wave-1 validation matrix + `processLogo` re-encode run on
  upload; only the 512 px main PNG (base64) is stashed in the draft (raw bytes
  never kept). Preview/remove/replace, accent colour, display/legal name and
  footer prefilled from earlier answers. Fully skippable — "add later in
  Settings → Branding".

## 6. The confirm-time application chain (`runConfirmChain`)

One server action, sequential and idempotent; **this is the only place
anything is created or applied**:

1. Validate the full intake (an incomplete draft never claims), then atomically
   **claim** the draft (status-guarded jsonb claim; stale claims >10 min are
   reclaimable — the applyOnboarding idiom) so a double-tapped confirm can't
   run twice.
2. `createOrgForUser` (the existing bootstrap) → stash `confirm.org_id`.
3. In org ctx (the creator is the owner by construction):
   `startOnboarding` with the confirmed intake (`template_key` = the confirmed
   choice) → `applyOnboarding` — **the ONLY template application, strictly
   after the explicit confirm** → stash `session_id` / `applied`.
4. `recordTierSelection` → `app_settings['subscription.selected_tier']`
   (audited upsert through the same org key-value store the config pipeline's
   blob artifacts use). **A recorded choice only: no `org_addon` writes, no
   plan change, no payment.**
5. If a logo/fields were stashed: `uploadLogo` + `saveBranding` through the
   real wave-1 branding service.
6. `completeDraft` → redirect `/o/<orgId>?welcome=1`.

Every completed link is stashed in `draft.data.confirm`, so a failure mid-chain
is **safe to retry**: the claim is released, the progress is kept, the review
screen explains honestly ("your workspace was created but setup didn't finish —
press the button to finish; nothing will be duplicated"), and the next confirm
resumes at the first unfinished link (org created but template failed ⇒ the
retry applies the template into the SAME org). `resolveLanding` and the
onboarding page route such a founder straight back to review — this is the one
case where a user with an org still sees the flow. Integration-tested end to
end (fresh chain, double-confirm, incomplete-draft refusal, mid-chain resume)
in `tests/integration/onboarding-draft.test.ts`.

**Templates configure structure only.** The chain seeds **no** customers,
employees, suppliers, jobs, orders, inventory, invoices or payments — asserted
as zero-row checks in the integration test.

## 7. Honesty statements (verbatim on-screen)

- Plan step + review: *"No payment is collected now — online payment isn't
  enabled yet, and your selection is only recorded as your choice. Your
  workspace starts on the standard 14-day full trial either way, and paid
  activation happens later through the governed billing activation process."*
- Proposal step: *"This is a preview — nothing is created or applied until you
  confirm at the end."*
- Review confirm card states exactly what the button will do (create the
  workspace, apply the named template setup, record the plan choice, save
  branding) and that nothing has been created yet.
- Tier prices render through the shared `<TierCards>` — always next to the true
  individual member total, indicative + tax-exclusive (the U3 honesty rules
  carry through unchanged).

## 8. Files

- `supabase/migrations/0073_onboarding_draft.sql` — table + RLS + grants.
- `src/modules/onboarding/flow.ts` — pure: schemas, steps, skips, mapping,
  tier shape, review builder.
- `src/modules/onboarding/draft.ts` — draft CRUD (withUserCtx), confirm claim/
  stash, tier recording, branding appliers, logo stash.
- `src/modules/onboarding/service.ts` — `runConfirmChain` + the module's
  public surface (re-exports).
- `src/app/(auth)/onboarding/` — `page.tsx` (host), `steps.tsx` (screens),
  `actions.ts` (step submits + confirm), `RegionFields.tsx`, `LogoPicker.tsx`.
- Tests: `tests/unit/onboarding-flow.test.ts`,
  `tests/unit/onboarding-flow-mapping.test.ts`,
  `tests/integration/onboarding-draft.test.ts`.
