# Owner Pricing Decisions — Anchors vs Research

> The owner supplied five price anchors before the market research ran. This document records each
> anchor against the researched evidence ([ADDON_MARKET_RESEARCH.md](./ADDON_MARKET_RESEARCH.md),
> official pages 2026-07-15), the verdict, and the rationale for any difference. All outcomes are
> part of the **recommended launch catalogue** (`is_placeholder = true` in 0065) and require the
> ratification below before any public launch.

## Anchor 1 — Accounting at $9/mo → **KEPT** (as the Finance bundle price)

- **Owner anchor:** "accounting" module ≈ $9/mo.
- **Research comparison:** standalone SMB accounting entry tiers run far higher (Xero Early $25,
  QuickBooks Simple Start $38, FreshBooks Lite $23, Zoho Books Standard $15–20); GCC entry tiers
  SAR/AED 60–140/mo (~$16–37). But IdaraWorks' "accounting" is an ops-side money module set, not a
  general ledger — the right comparable is module/add-on pricing, where $9 is plausible.
- **Decision:** the anchor becomes the price of `bundle.finance` (payments_ar $5 +
  expenses_cashbook $4 + quote_vs_actual $3 = **$12 of contents for $9, −25%**). The owner's number
  is honoured exactly while individual modules stay independently priced.
- **Difference rationale:** none in amount; the shape changed from "a module" to "a bundle" so the
  catalogue stays composable.

## Anchor 2 — Quotes + invoices at $5/mo → **KEPT**

- **Owner anchor:** $5/mo.
- **Research comparison:** squarely inside the verified **$4–10 flat small-module band** (Xero
  pattern; Zoho Books micro add-ons $7–10). Standalone invoicing products charge more (FreshBooks
  Lite $23) — as an add-on module, $5 is at-market.
- **Decision:** `addon.quotes_invoices` = **$5/mo (AED 19)**, with GCC e-invoicing included when D1
  opens (never sold separately — the ZATCA-always-bundled finding).

## Anchor 3 — +10 members at $5/mo → **KEPT**

- **Owner anchor:** $5/mo per pack of 10 members.
- **Research comparison:** = **$0.50/seat/mo** — below every researched per-seat norm: GCC
  SAR 8–20/user/mo (~$2.10–5.30; Zoho Books SA SAR 8–10, Qoyod SAR 20), Zoho Books US $2.50/user,
  FreshBooks $11/user, Jobber $29/user.
- **Decision:** `addon.members_10` = **$5/mo, stackable** (+10 office + 10 viewer seats; field
  seats always free/unlimited).
- **Difference rationale:** aggressive but defensible **as a pack**: seats are deliberately not the
  margin engine (modules are), the pack shape keeps invoices simple, and underpricing seats removes
  the strongest objection field-heavy GCC SMBs have to SaaS. Flagged for owner awareness: this is
  ~4–10× below market and cannot be raised easily after launch without churn risk — confirm it
  knowingly.

## Anchor 4 — Document logo at $2/mo → **KEPT**

- **Owner anchor:** $2/mo.
- **Research comparison:** **no verified market comparable exists.** Branding removal is typically
  tier-gated, not priced (Zoho Invoice free tier carries "Powered by Zoho"; app-store norms gate
  branding removal to $20–50/mo tiers — unverified pattern, not a citable price).
- **Decision:** `addon.branding_docs` = **$2/mo (AED 8)** — a below-market micro-price that works
  as an easy, emotional first purchase and a card-on-file activator.

## Anchor 5 — In-app branding at $1/mo → **KEPT**

- **Owner anchor:** $1/mo.
- **Research comparison:** as above — no verified comparable; white-label/in-app branding is never
  individually priced by the researched vendors.
- **Decision:** `addon.branding_app` = **$1/mo (AED 4)**. Same micro-price logic: negligible
  revenue, high attachment, lowest-friction first paid action in the product.
- **Flag on 4 & 5:** both are knowingly below any market anchor; they are conversion mechanics, not
  revenue lines. If payment-processor per-transaction minimums (post-D1) make $1–2 lines
  uneconomic, the fallback is bundling them (branding_docs is already in `bundle.starter_ops` and
  both are in `bundle.full_ops`).

## Summary

| # | Owner anchor | Researched band | Recommended | Verdict |
|---|---|---|---|---|
| 1 | Accounting $9 | modules $4–10; GCC entry ~$16–37 | Finance bundle $9 (contents $12, −25%) | KEPT |
| 2 | Quotes+invoices $5 | $4–10 flat module band | $5 | KEPT |
| 3 | +10 members $5 | GCC SAR 8–20/user (~$2.10–5.30/user) | $5/pack = $0.50/seat | KEPT (below market — confirm knowingly) |
| 4 | Doc logo $2 | no verified comparable | $2 | KEPT (micro-price mechanic) |
| 5 | App branding $1 | no verified comparable | $1 | KEPT (micro-price mechanic) |

## Ratification checklist — owner must confirm before public launch

1. ☐ **Ratify each price** in [ADDON_CATALOGUE.md](./ADDON_CATALOGUE.md) and
   [BUNDLE_CATALOGUE.md](./BUNDLE_CATALOGUE.md) — or amend; on ratification, flip
   `addon_price.is_placeholder` / plan prices to false via a new migration (never edit 0065).
2. ☐ **Confirm anchor 3 knowingly** — $0.50/seat is 4–10× below market and hard to raise later.
3. ☐ **Confirm the AED companion figures** (clean-rounded ~3.67×) and that AED is the second launch
   currency (SAR list deferred or added?).
4. ☐ **Confirm tax-exclusive labelling** (ex-VAT everywhere, VAT added at billing) vs the
   Qoyod-style tax-inclusive convention for KSA surfaces.
5. ☐ **Confirm yearly = 10× monthly** (two months free) as the sole annual discount.
6. ☐ **Confirm e-invoicing stays bundled** inside quotes_invoices at no extra charge when D1 opens.
7. ☐ **Confirm the free plan limits** in [FREE_PLAN_DEFINITION.md](./FREE_PLAN_DEFINITION.md)
   (3 office seats / 3 viewers / unlimited field / 10 active jobs / 1 GB) and the
   14-day-trial→free landing model.
8. ☐ **Decision D1** (real payment provider) — required before any money is actually collected;
   until then all purchases are founder-operated manual activations.
9. ☐ **Confirm manual_process pricing** (extra_org $9, priority_support $9) is operationally
   sustainable at pilot scale.
10. ☐ **Legal review** of pricing-page copy (placeholder/indicative labels, ex-VAT notice,
    availability-honesty notes) in both EN and AR.
