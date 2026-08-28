# IdaraWorks pricing strategy (2026 launch)

Research date: 2026-08-29. All competitor figures were read directly from the
official pricing pages on that date (no aggregators, no blogs). Promotions are
recorded separately from list prices.

## Official sources

- Monday Work Management: https://monday.com/pricing
- ClickUp: https://clickup.com/pricing
- Odoo: https://www.odoo.com/pricing
- Jobber: https://www.getjobber.com/pricing/
- QuickBooks Online UAE: https://quickbooks.intuit.com/ae/online-compare/

## Competitor matrix (as listed on 2026-08-29)

| Product | Model | Entry paid | Mid | Upper | Included users | Annual structure | Promotions seen (separate from list) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Monday Work Mgmt | Per user | Basic $9/user/mo | Standard $12/user/mo | Pro $19/user/mo, Enterprise custom | Free plan up to 2 seats; paid calculator starts at 10 seats | ~18% off when billed annually | "$10-30 off/mo" banners per tier |
| ClickUp | Per user | Unlimited $10/user/mo ($7 annual) | Business $19/user/mo ($12 annual) | Enterprise custom | Free Forever (60MB, 5 spaces) | Up to 30% off annually | AI plans sold separately ($9-28/user/mo) |
| Odoo | Per user (all apps) | Standard $28.80/user/mo ($22.80 annual) | - | Custom $44.20/user/mo ($35.20 annual) | One App Free: unlimited users, one app | Annual discount is a 12-month new-user promotion | Annual price labelled promotional |
| Jobber | Per organization | Core $49/mo list ($21/mo prepaid annual) | Connect $139/mo ($70 annual), Grow $199/mo ($105 annual) | Plus $499/mo ($280 annual) | 1 user included (Plus: 5); extra users $29/user/mo | Prepaid annual, deep gap vs monthly | "Save up to 40%, ends Aug 31" on annual |
| QuickBooks UAE | Per organization, fixed seats | Simple Start AED 77/mo (~$21) | Essentials AED 114 (~$31), Plus AED 169 (~$46) | Advanced AED 327 (~$89) | 1 / 3 / 5 / 25 users (+ accountant) | Billed in USD; AED display | ~70% off for 6 months on every tier |

## Pricing-model comparison

Two clusters exist:

1. **Generic work managers** (Monday, ClickUp, Odoo): per-user pricing. Cheap
   per seat, expensive per team; Monday's 10-seat calculator makes the real
   entry ~$90+/mo, and none of them ship an operations record (quotes, POs,
   costing, field reports) out of the box.
2. **Specialist business operating tools** (Jobber, QuickBooks): per
   organization with included seats. Jobber charges $29/mo per extra user;
   QuickBooks fixes seats per tier. Their $39-199 organization band is where
   an SMB expects to pay for a tool that runs the business, not just tasks.

IdaraWorks is a specialist operating system, so it prices like the second
cluster: **per organization, seats included**, undercutting the per-user
cluster for any real team (5 office users on Monday Standard = $60/mo before
the 10-seat floor; on IdaraWorks Operations the whole organization is $39).

## IdaraWorks positioning

- Free is a real permanent base (3 office users, unlimited field-app users,
  core operations), not a trial.
- Operations ($39/org/mo) lands on Jobber Core's list price while including
  13 office users where Jobber includes one; it is the "connect customers,
  work and money" step.
- Complete ($89/org/mo) matches QuickBooks Advanced's effective price while
  covering operational breadth accounting tools do not (field reports,
  material flow, costing, approvals) plus branding and extra storage.
- Annual = 20% off, plainly stated, no countdown promotions.

## Selected launch prices and names (public)

| Public name | Internal tier (unchanged) | Monthly | Annual equivalent | Billed annually | Included office users (real entitlements) |
| --- | --- | --- | --- | --- | --- |
| Free | `free` | $0 | $0 | - | 3 office users, unlimited field users |
| Operations | `medium` | $39 per organization | $31/mo | $372/yr (save 20%) | 13 office users, unlimited field users |
| Complete | `high` | $89 per organization | $71/mo | $852/yr (save 20%) | 13 office users, unlimited field users, extra storage |

Supporting lines: Operations "For teams ready to connect customers, work and
money." Complete "For businesses that need full operational control and
visibility."

## Seat-limit decision (conflict documented)

The requested target packaging was 1 / 5 / 10 users. The real entitlements
are different and were NOT changed:

- Free: `limit.full_users` = 3, viewers 3, field users unlimited by product
  law (`FREE_PLAN_LIMITS`).
- The `medium` and `high` tier bundles both include `addon.members_10`,
  giving 3 + 10 = **13** office users; `high` adds `addon.storage_25gb`.

Decision: the interface displays the real limits (3 / 13 / 13, unlimited
field users everywhere) and keeps the selected organization prices. This is
commercially coherent: including 13 office seats at $39 strengthens the
against-per-user comparison rather than weakening it, and no entitlement was
silently altered.

## Separation from the disabled payment system

- The payment provider remains **disabled** (D1 gate;
  `BillingProviderDisabledError`); no checkout, subscription creation, or
  charge is possible. Nothing in this micro-step changes that.
- The prices above are **approved public launch targets** rendered only by
  the marketing homepage (`src/app/_home/pricing.ts`, consumed by the
  homepage and its tests alone). The billing price book
  (`platform/entitlements/addons.ts`, `is_placeholder`) is untouched because
  live subscription math reads it.
- The homepage states this honestly: early access is free while billing is
  prepared; these are the planned launch prices.

## Unresolved billing decisions (owner)

1. Ratify the internal price book to match the public targets before
   enabling payments (the placeholder book currently carries $15/$39 tier
   stickers from the bundle-discount study; the public targets are $39/$89).
   The bundle-vs-members discount curve in ADDON_PRICING_RATIONALE.md must be
   re-run at the ratified numbers so no tier becomes a dominated sticker.
2. Decide AED list prices (public targets are USD; QuickBooks UAE displays
   AED and bills USD, which is an acceptable pattern here too).
3. Annual billing does not exist in the provider yet; the 20% annual
   structure is a public commitment to implement, not a live billing mode.
4. Decide whether the add-on marketplace (0065 model) or the three tiers are
   the customer-facing purchase surface at launch; the homepage sells the
   three-tier story either way.
