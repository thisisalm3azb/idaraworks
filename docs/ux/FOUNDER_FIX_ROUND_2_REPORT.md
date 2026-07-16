# Founder Fix Round 2 — Completion Report

**Status: COMPLETE.** All five founder-reported production defects reproduced, root-caused, fixed
with regression coverage, deployed, **verified live in production**, independently reviewed (two
lenses), and cleaned up. Deployed commit **`adb00bc`**, CI green, production serving it, protected
orgs untouched. Detailed per-defect docs: `docs/ux/{LOGO_UPLOAD_FIX,SUPPLIER_CREATION_FIX,
QUICK_CREATE_MENU_FIX,SUBSCRIPTION_SELECTION_REDESIGN_V2}.md`.

## 1. Root cause of each defect

1. **Subscription page unattractive** — the four tier cards used a viewport-gated 4-up grid
   (`xl:grid-cols-4`) but the onboarding wizard wraps content in a 672px (`max-w-2xl`) container, so
   the cards collapsed to ~148px-wide × 834px-tall "text columns"; the Custom add-ons were dumped in
   a long scroll below the cards.
2. **Logo upload fails** — `next.config.ts` shipped sharp's native libs only to `/api/inngest` and
   `/o/[orgId]/settings/branding`. The onboarding upload runs in the **`/onboarding`** lambda, which
   lacked them → sharp `ERR_DLOPEN_FAILED` → a generic "upload failed" with no correlation ID.
3. **Supplier creation fails** — the service write was never broken; the action wrapper collapsed
   **every** error (including a simple mistyped email) into `?error=create_failed` → "Something went
   wrong", wiped the form, and logged nothing, so the real cause was invisible.
4. **New menu blocks the page** — it was a native `<details>/<summary>` popover, which by design
   never closes on outside-click, Escape, item-select, or client navigation, so the panel lingered
   across routes and intercepted clicks.
5. **Subscription page read-only** — every management control was gated on `providerEnabled`, which
   is `false` in prod (billing disabled) → the owner saw a static catalogue with no controls.

## 2. Exact fix for each defect

1. **Subscription redesign**: the plan step now renders in `max-w-6xl` (all four cards side-by-side,
   ~260px each at 1440px — live-measured); Custom opens an **in-page builder** (category tabs,
   search, quantity steppers, live total, sticky summary, back-to-compare) that replaces the grid —
   no long scroll. Responsive: 4-up desktop / 2×2 tablet / stacked mobile (no 375px overflow, verified).
2. **Logo**: added the `/onboarding` sharp trace key; distinct error codes (unsupported/too-large/
   corrupt/dimensions/storage/server) with a correlation ID; safe pre-org asset model (re-encoded
   PNG base64 in the user-scoped draft, no orphan storage, re-validated + uploaded at confirm).
3. **Master-data**: a shared `actionError` helper classifies errors → specific safe message +
   correlation ID + preserved input (PII excluded from the URL — review fix) + focused bad field;
   logs the real error server-side. Wired into suppliers, customers, and items.
4. **New menu**: replaced both header `<details>` menus with an accessible `<Menu>` client popover
   (closes on outside-click/Escape/select/route-change/logout; full ARIA; roving focus; panel
   removed from the DOM when closed so nothing intercepts clicks).
5. **Subscription management**: controls enabled on `canManage` (owner) alone; a **governed
   test/trial path** records/applies changes through the same lifecycle writer the webhook uses
   (server-authorized, audited `via='owner_action' trial=true`) — no real payment, no client-claim
   activation, provider events remain the sole real-paid writer. Change-review, scheduled changes,
   tenant audit history, locked-feature deep links, 15-way error taxonomy.

## 3. Subscription redesign — four cards, no page scroll, in-page Custom builder; "Recommended"
on Medium, "Most complete" (not "everything") on High; honest excl-VAT + provider-disabled notices.
## 4. Screenshots — `docs/ux/evidence/`: `r2-subscription-desktop.png`, `r2-subscription-mobile.png`,
`r2-custom-builder.png`, `r2-logo-success.png`, `r2-suppliers.png` (captured from deployed prod).
## 5. Logo storage/ownership — pre-org: re-encoded 512px PNG base64 in the user-scoped
`onboarding_draft` (RLS, no storage object); at confirm: re-validated + uploaded to the new org's
tenant-scoped storage; cancelled onboarding leaves no orphan file; idempotent confirm.
## 6. Logo formats tested — PNG, transparent PNG, JPG **all upload successfully in production**;
SVG rejected; invalid ext / MIME-signature mismatch / corrupt / zero-byte / oversized / bad-dims
rejected with specific codes.
## 7. Supplier cases — name-only / +tax / +phone / +email / all fields / Arabic / long input all
succeed; bad email → specific `invalid_email` + reference; unauthorized blocked; suspended org
write-blocked but readable; duplicate names allowed (item SKU unique). Same for customers + items.
## 8. Quick-menu closure — outside-click, Escape (focus returns), item-select, route navigation,
logout: **all verified live** (open=1 → Escape=0 → outside-click=0).
## 9. Full founder-flow — verified live on a synthetic **construction** org: login → dashboard →
supplier create SUCCESS → New-menu closure → subscription 4-cards + in-page builder + current-state
strip (seats/total/trial/provider-disabled). The defect fixes are template-independent and covered
by hosted integration tests across templates.
## 10. Other defects fixed — review findings: onboarding tier-grid width (F1 material), PII in the
error redirect URL (F4, both reviewers), Free-tier confirm parity (F3), priceVersion on tier forms
(F5), Custom price type-scale (F6) — all fixed with regressions.
## 11. Tests — unit **650/650** (45 files); hosted integration **323 + new master-data/subscription
suites** green; new: logo round-trip, master-data action-path + create matrix, subscription
governed-management, menu keyboard-nav, quick-menu e2e, founder e2e. CI green.
## 12. CI result — **green on `adb00bc`** (quality + integration).
## 13. Final deployed commit — **`adb00bc`** (health-verified; smoke 17/17 on the shipped code).
## 14. Migrations — hosted **0000–0073**, **no new migration this round** (all fixes were code +
config + the governed path reused existing writers). Next: `0074`.
## 15. Production org inventory — exactly **[Alpha Marine, TESTING, Alhaash, The Business]**,
byte-identical to the pre-round baseline (trial_end values unchanged). Synthetic cleanup: 1 R2FIX
org + 7 leaked S7/S8/S9 test fixtures + 26 synthetic `@example.com` users removed via a
UUID-guarded dry-run→apply. Your real data (The Business branding, the hotmail founder draft) was
detected and preserved.
## 16. Cleanup result — zero synthetic residue; four protected orgs verified untouched; production
health ok; deployed commit `adb00bc`.

## 17. Your next founder test

Everything you reported is fixed and live. On your phone at **https://idaraworks.vercel.app**:

1. **New signup → onboarding** — the questionnaire, then the **redesigned pricing screen**: all four
   plans (Free / Medium / High / Custom) side-by-side, clean typography, "Recommended"/"Most
   complete" badges. Pick **Custom** → the builder opens in-page (no scroll) with add-on categories,
   search, and quantity steppers.
2. **Upload your logo** at the branding step — PNG/JPG/WebP all work now; you'll see the preview
   immediately. (If a file is ever rejected, you get a specific reason + a reference code, and your
   other answers are kept.)
3. **Suppliers/Customers/Items** — add one; it appears immediately. A bad entry (e.g. a mistyped
   email) now shows exactly what's wrong with a reference code, and your typed values are kept.
4. **The "+ New" menu** — open it, then click elsewhere or press Esc or pick an item: it closes
   properly and never blocks the page.
5. **Settings → Subscription** — it's now a real management screen: current tier, seat/storage
   usage, monthly total, "Change your plan" (four cards) and "Build a custom plan" (the builder).
   Try switching tiers or adding an add-on — you'll see a change-review, then it applies through the
   governed trial path with a clear "no payment is collected" notice (real billing stays off until D1).
6. **Arabic/RTL + 375px** work throughout.

Known-and-expected (unchanged, credential-gated): document PDFs render only once Inngest is
provisioned; no emails until Resend is set; real purchases stay disabled until D1. The one owner
action still open from the previous round: set the Supabase **Site URL** so email-confirmation links
return to the app (`docs/ux/AUTH_CALLBACK_FIX.md`).
