# Subscription Selection Redesign V2 + Governed Management (U3 / PART A–E)

> Extends [SUBSCRIPTION_SELECTION_FLOW.md](./SUBSCRIPTION_SELECTION_FLOW.md). The
> four-path model, the ONE entitlement system, the price catalogue and the
> honesty law are unchanged — this document covers (A) the redesigned selection
> surface and (B) turning the post-onboarding settings page into a real,
> self-service management surface via a **governed test/trial path**, with (C)
> error handling, (D) tests and (E) this doc. No second entitlement system, no
> new tables, no migration — every change reuses the existing bundle/add-on keys,
> price versions, resolver, lifecycle writers and audit.

---

## PART A — the redesigned four-path selection

### Components (all in `src/platform/ui/subscription/`)

| Component | Role |
|---|---|
| `SubscriptionSelector` (client) | The single orchestrator both surfaces embed. Holds the transient `compare ↔ custom` panel state and swaps the tier comparison for the builder IN-PAGE (no navigation). |
| `TierCards` (client) | The four EQUAL comparison cards (Free / Medium / High / Custom). |
| `CustomBuilder` (client) | The à-la-carte panel: category tabs + search + steppers + live subtotal + sticky summary + change-review. |
| `review.ts` (pure) | `buildChangeReview(current → desired)` — the delta/total maths, unit-tested. |

All three import the **client-usable** `t()` (`@/platform/i18n/t`, the same one
`MfaClient` uses) and take `locale`, so no serialized labels bag is threaded from
the server. Money uses `formatMoney` (latin numerals under `ar`, F-44).

### "All four visible, no page-level scroll at 1440×900"

The grid is `grid-cols-1 md:grid-cols-2 xl:grid-cols-4` (`data-testid="tier-grid"`):

- **Desktop (≥1280px):** 4-up — all four cards on one row, ~320px each at 1440px.
  Cards are compact by construction: title+badge, a prominent price block, a
  one-line audience descriptor, 4–6 short **benefit bullets** (never paragraphs),
  seats/storage, a primary button, and a **collapsed** `<details>` "full feature
  list" that adds zero height until opened. The basic comparison fits 900px with
  no page scroll.
- **Tablet (768–1279px):** 2×2.
- **Mobile (<768px):** stacked, 44px targets; the onboarding step shows a sticky
  Continue once a choice is made.

Proven in `tests/unit/subscription-selector-render.test.ts` (renders to static
markup and asserts the grid classes + all four card titles + prices).

### Price legibility (no overlap / no awkward wrap)

The price block is a two-line unit: a big `font-mono` number + a **non-wrapping**
`whitespace-nowrap` `/mo`, then `excl. VAT · indicative` on its own line. The
line-through member total + `Save NN%` badge sit on a separate line. `$0` renders
as "Free"; the Custom card shows "Pay as you go" (never a misleading `$0`).

### Custom is a first-class fourth card

Equal size to the tiers. Its button calls `onOpenCustom()` (wired by
`SubscriptionSelector`) which **replaces** the comparison with `<CustomBuilder>` —
never a long list dumped below the grid. A `customHref` fallback (anchor link)
exists only for read-only surfaces with no orchestrator.

### `CustomBuilder` — never one unstructured scroll of 19 add-ons

Category tabs + a search box filter the grouped cards (two columns from `md`).
Each card carries concise copy, a monthly price, a stepper (stackable packs) or
checkbox, and an honest indicator badge: **Included in your bundle** (no double
charge), **Needs activation** (credential-gated), **Opens at D1** (d1-gated),
**Set up with support** (manual). Deferred items never reach the builder
(excluded by `buildSelectionView`). A **sticky summary** shows the selected count
+ live monthly subtotal; a **Reset** restores the initial set; **Back to
comparison** returns. In settings, a **Review & confirm** step shows the full
diff before submit (below).

### No silent preselect / persistence

`current` is a **display mapping only** (`currentSelectionLabel`) — no card is
preselected. In onboarding the choice lives in the draft (0073) and resumes on
refresh/back/forward; the plan step opens the builder pre-filled when the draft's
mode is `custom`. In settings the choice is the org's real add-on state.

---

## PART B — the settings page as a real management surface (governed test path)

### The defect

Every control was gated on `canManage && view.providerEnabled`. In prod the real
payment provider is **disabled** (`providerEnabled = false`, D1 closed), so the
owner saw a read-only catalogue with zero controls.

### The fix: enable on `canManage` alone, route through a governed path

- Management is gated on `canManage` **alone** (`billing.manage` → owner only;
  admin/accounts are `billing.view` = read-only; enforced in the SERVICE via
  `assertCan`/`can`, and by the DB DEFINER writers — never client-only).
- The `providerEnabled` gate is **removed from the controls**. When the real
  provider is disabled, confirmed changes go through the **governed test/trial
  path** instead of throwing `BillingProviderDisabledError`.

### How a paid change is "recorded" without real payment or client-claim activation

`src/modules/subscription/service.ts`:

```
applyGovernedAddonChange(ctx, archetype, req, opts)   // add/remove/bundle/tier
applyGovernedAddonSet(ctx, archetype, desired, opts)  // builder submit = make the set equal desired
applyGovernedGoFree(ctx, archetype, opts)             // schedule removal of every live add-on
applyGovernedCancellation(ctx, archetype, opts)       // reuse the existing state machine
```

Each one:

1. **Authorizes server-side** — `can(archetype, "billing.manage")`; a non-owner is
   refused with a classified `authorization` error. This is the sole gate; a
   forged client request cannot reach the writers.
2. **Blocks read-only states** (`assertTenantWritable`, FR-9).
3. **Guards the price version** — the review's `priceVersion` (a `currentPriceVersion()`
   fingerprint of the whole catalogue) must still match, else `stale_price_version`.
4. **Plans the change with the SHARED `planAddonChange`** — the *same* validation,
   honesty, quantity-bounds and decrease/removal laws `changeAddons` uses (extracted
   into one pure function, so the two paths can never diverge).
5. **Applies through the SAME lifecycle writer the provider webhook uses** —
   `applyAddonChange` / `applyTransition` on a **no-context platform client**
   (`app.set_org_addon` / `app.advance_subscription`, DEFINER, `assert_platform_task`),
   attributed **`via = 'owner_action'`, `trial = true`** in the audit `after_data`.

**Why this is not a second writer and does not violate "provider events are the
sole writer of PAID activation":** the governed path grants a real entitlement for
the trial/pilot and collects **no money** — and it never *claims* money moved. Real
**paid** activation (an actual charge) still only lands through a **verified provider
event**, which stays the sole writer of that. The governed path is
server-authorized + audited; a client claim can never grant entitlements because
the DEFINER writers are reachable only through these owner-gated functions.

The fake provider round-trip (`changeAddons` → `emitFakeSignal`) is retained for
dev/test and the existing integration tests; nothing about it changed except that
its validation now comes from the shared `planAddonChange`.

### What the page shows (not just lists)

Current tier (`currentSelectionLabel`), monthly total (`computeMonthlyTotalMinor`
— bundle counted once), billing state, trial status + end, seat + storage usage,
active add-ons split **bundle-derived vs individually-selected** (labelled),
scheduled changes with effective dates, and the honest **governed test notice**
("No payment is collected — this is a trial/test selection; paid activation opens
at D1"). "Change your plan" renders the `SubscriptionSelector` (tiers +
Manage-add-ons builder).

### Change-review before submit

The builder's **Review & confirm** step (`reviewBeforeSubmit`) shows current vs
new: added/increased (apply now) vs removed/reduced (at period end), current vs
new monthly total + the difference, the immediate-vs-scheduled note, a
no-data-deletion statement, and tax-exclusive wording — then an explicit confirm.
Tier changes use the two-step confirm with an honest body.

### Lifecycle preserved

Upgrades/additions immediate; downgrades/removals scheduled to period end (no data
deletion); partial stackable **decreases** follow the existing remove-and-re-add
guidance (the `org_addon` model holds one quantity per key — a documented, honest
choice, not a silent partial reduction). Cancellation reuses the existing state
machine (`nextForEvent` + `applyTransition`) — no second machine. Double-confirm is
idempotent (`set_org_addon` upsert). Price-version handling as above.

### Audit history (tenant-visible)

`readSubscriptionAuditHistory` reads the org's OWN `audit_log` subscription rows
(RLS-scoped — a tenant sees only its own; the platform stream stays separate) and
derives a **source** for each: `onboarding` (action prefix), `owner_action` /
`provider_event` / `platform_override` (the `after_data.via` marker; legacy rows →
`provider_event`), plus a status (applied/scheduled) and effective date.

### Bundle ↔ Custom switching

The resolver dedupes on `(org_id, addon_key)`, so an add-on already provided by a
bundle is one row / one charge. The builder marks those **Included in your bundle**
(not re-selectable, excluded from the submit), so individually-selected add-ons are
never silently discarded.

### LockedFeature deep links

`LockedFeature`'s CTA links to `…/settings/subscription`. The page reads
`?highlight=addon.<key>`: it opens the builder (`initialPanel="custom"`) with the
target add-on focused (`highlightKey` → a ring on `#addon-<key>`).

---

## PART C — error handling

`classifySubscriptionError(err)` maps any failure onto a safe `SubscriptionErrorCode`
+ a correlation id, distinguishing: `authorization`, `read_only`, `invalid_quantity`,
`unavailable_addon`, `credential_gated`, `d1_gated`, `deferred`, `unknown_addon`,
`not_active`, `stale_price_version`, `concurrent_change`, `invalid_transition`,
`provider_unavailable`, `network_retry`, `internal`. The action logs the real error
under the correlation id and redirects to `?notice=error&code=<code>&cid=<id>`; the
page shows `subscription.error.<code>` + the reference id — never a DB/provider
internal. The proposed selection is retained (the builder is client state).

---

## PART D — tests

- `tests/unit/subscription-management.test.ts` — `buildChangeReview`,
  `planAddonChange` laws, `classifySubscriptionError`, `currentPriceVersion`, the
  tier member lists + savings **recomputed from `addons.ts`** (Medium $28→$15 −46%,
  AED 106→55 −48%; High $75→$39 −48%, AED 282→143 −49%), and EN+AR coverage of every
  error code / audit source.
- `tests/unit/subscription-selector-render.test.ts` — renders to static markup:
  all four options; 4-up desktop grid + stacked mobile; price/`/mo` separate (no
  overlap); no silent preselect; Custom opens the builder in-page (no navigation);
  SR labels on steppers; bundle-included indicator; EN + AR/RTL.
- `tests/integration/subscription-management.test.ts` — with `BILLING_PROVIDER=disabled`
  (the prod scenario): the page is NOT static (owner change applies, audited
  `owner_action`, no charge); a non-owner cannot change (authz, nothing written);
  additions immediate / removals scheduled; tier overlap = one row; duplicate confirm
  idempotent; stale-price guard; tenant-visible audit history; and the protected
  production orgs (Alpha Marine / TESTING / Alhaash / The Business) read + display
  correctly **without any write**.

---

## PART E — existing-org safety + honesty model

Existing orgs (including the protected production orgs) are **never auto-converted**:
the governed path only INSERTS `org_addon`/audit rows on an explicit owner action;
the display mapping is read-only. The honesty model is intact: no payment is ever
collected while the provider is disabled; nothing claims money moved; deferred items
are never selectable; gated items are visible-but-not-buyable with their reason; tier
prices always show next to the true member total and % saving.
