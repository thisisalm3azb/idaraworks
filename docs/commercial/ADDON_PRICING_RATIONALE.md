# Add-on Pricing Rationale — Research → Catalogue Mapping

> **Status: RECOMMENDED LAUNCH CATALOGUE — not a commitment.** Every price in
> `src/platform/entitlements/addons.ts` and migration 0065 is seeded with
> `is_placeholder = true` and labelled indicative **pending owner ratification**
> ([OWNER_PRICING_DECISIONS.md](./OWNER_PRICING_DECISIONS.md)). Real payment collection remains
> D1-gated; nothing here is legally or irreversibly committed.
>
> Evidence base: [ADDON_MARKET_RESEARCH.md](./ADDON_MARKET_RESEARCH.md) (official pages, 2026-07-15).

## 1. The pricing shape we chose

IdaraWorks sells a **free base + flat monthly per-org add-on modules + discounted bundles** —
closest to the Xero (cheap flat feature add-ons on an org plan) and Katana (platform + modules)
patterns, deliberately NOT Odoo's per-user-unlocks-everything or Zoho One's all-employee licensing.
Rationale: our buyers are GCC field-operations SMBs where office headcount is small and field
headcount is large — per-user pricing on field staff is the single most alienating pattern for this
market (Jobber's $29/user is a US-priced anomaly; ServiceM8, Xero, Procore, Buildertrend, AgriWebb
all chose unlimited users). We charge for **office seats in packs** and keep **field seats free and
unlimited**.

## 2. The $4–10 flat small-module band (Xero pattern)

Research: Xero Inventory Plus $39/mo is the outlier "big" module; its small modules land at ~$4–7/mo
(Expenses from $4, Projects from $7 — snippet-sourced, flagged unverified); Zoho Books micro add-ons
run $7–10/mo; the synthesis band for small flat feature modules is **$4–10/mo**.

Our module prices sit inside or below that band:

| Our price | Modules |
|---|---|
| $3/mo | goods_receiving, items_catalogue, quote_vs_actual, customer_updates, data_import, exports_extended |
| $4/mo | storage_25gb, expenses_cashbook, purchase_requests, approval_workflows, audit_history |
| $5/mo | quotes_invoices, payments_ar, purchase_orders, labour_timesheets, owner_digest, members_10, automation_workers* |
| $6–9/mo | ai_pack $6*, job_costing $7 (the deepest module — flagship), extra_org $9, priority_support $9 |

\* credential-gated, visible-not-purchasable today.

$7 for job costing is justified as the highest-value single module (Jobber gates job costing to its
$149/mo Grow tier; ServiceM8 to its $149 Premium tier — we sell it à la carte for $7).

## 3. Per-seat pack norms

Research: QuickBooks payroll meters **$7–13/employee/mo** (displayed) and $5–10 per Intuit help
content; FreshBooks charges $11/user/mo; Zoho Books $2.50/user/mo; GCC vendors cluster at
**SAR 8–20/user/mo (~$2.10–5.30)**; Jobber $29/user (US field-service anomaly).

Our `addon.members_10` is **$5/mo for a pack of 10 office seats = $0.50/seat** — deliberately below
even the cheapest GCC norm. This is aggressive but defensible as a *pack* (see
OWNER_PRICING_DECISIONS.md, owner anchor #3): the pack shape keeps the invoice line simple, and
seats are not our margin engine — modules are. Field/foreman seats are free and unlimited
(the ServiceM8/Procore/AgriWebb norm for field-heavy verticals), and employee **records** are never
metered at all.

## 4. The $25–45 "everything" band → Full Operations at $29

Research: the verified all-in bundles land at **Odoo Standard $28.80/user/mo (monthly billing;
$22.80 annual)** and **Zoho One All-Employee $37/user/mo**; the synthesis band for "everything"
pricing is $25–45. Our `bundle.full_ops` is **$29/mo flat per org** — numerically inside the band
but structurally far cheaper because it is per-organization, not per-user: a 5-office-seat org pays
$29 total where Odoo would charge ~$144/mo. That gap is the core commercial wedge, and $29 keeps
the anchor recognizable against the products GCC buyers already price-check.

## 5. Free-tier norms → our free base

Research (all verified): users are the standard free gate (1–2 users, or unlimited users + another
constraint); storage caps as low as 60MB are accepted; document volumes ~500–1,000/yr; **no vendor
gates exports on free**. Every GCC competitor has a free tier or a no-card trial.

Our free plan (see [FREE_PLAN_DEFINITION.md](./FREE_PLAN_DEFINITION.md)): 3 office seats +
3 viewers (more generous than Zoho Books' 1 or monday's 2), **unlimited free field seats** (the
vertical-appropriate Odoo-style twist: the whole crew gets in free), 10 active jobs, 1 GB storage,
unlimited employee records, core exports never gated. New orgs get a 14-day full-featured trial that
lands on free — never suspension. This matches or beats every researched free tier on the axes GCC
SMBs feel first.

## 6. Bundle discount logic (10–56%)

Bundles are discounted collections of the SAME add-on keys (never a second entitlement system —
enforced in `resolve.ts` and tested). The discount deepens with bundle size so that the sticker
maths always favours committing to more of the platform:

- small themed bundles: −10% to −25% (Starter Ops, Finance)
- functional suites: −37% to −40% (Procurement, Project Control)
- the recommended path: −21% (Growth — kept shallow because it is already the volume price point)
- everything: **Full Operations $29 vs $69 individually** (the deepest cut; code comment cites the
  −56% design target — see BUNDLE_CATALOGUE.md for the exact computed figures)

This mirrors the researched pattern where the all-in bundle makes per-module maths feel expensive
(Odoo/Zoho One), while small bundles stay close to sum-of-parts so à-la-carte never feels punished.

## 7. AED companion pricing

Research: showing prices in the local currency with clean local numerals is GCC table stakes (Zoho
prices SAR/AED natively with identical numerals; Daftra's USD-only display is the noted exception).
Our AED companion prices are **~3.67× USD rounded to clean figures** (e.g. $5 → AED 19, $29 →
AED 109, $2 → AED 8) — a true dual price list seeded in `addon_price`, not a checkout-time FX
conversion, so the AED number on the pricing page is the AED number on the invoice.

## 8. Tax-exclusive labelling

All catalogue prices are **tax-exclusive**, following the international-vendor convention verified
in-region (Zoho SA/AE "prices exclude tax"; Mezan "excludes VAT"; Daftra ex-tax) rather than the
local tax-inclusive convention (Qoyod). UAE VAT 5% / KSA VAT 15% are added at billing when D1 opens.
The research note stands: pick one convention per market and **label it clearly** — every price
surface must carry the ex-VAT label.

## 9. Why e-invoicing is INCLUDED with invoicing (never sold separately)

The strongest single regional finding: **every verified GCC vendor bundles ZATCA Phase 2
e-invoicing into standard plans** — Zoho Books SA (from Standard), Qoyod (Pro/Advanced), Daftra
(all plans), Mezan (base plan). No vendor publishes it as a paid add-on. Therefore
`addon.quotes_invoices` explicitly includes e-invoice submission **once regulatory activation (D1)
opens**, at no extra charge — the add-on copy already states "it is never sold separately".
Charging separately for compliance would be a competitive liability and would read as a compliance
tax; the module price carries it.

## 10. Honesty constraints on pricing

Prices only attach to what actually exists: `deferred` add-ons (inventory/stock, multi-location,
multi-currency, WhatsApp, API/webhooks) are priced at 0, get **no price rows** in 0065, and are
never purchasable. `credential_gated` and `d1_gated` items render visible-but-unavailable with the
honest reason. This is tested (the "honesty law" in addons.ts) and is itself a differentiator
against the quote-wall opacity (Procore, Cin7, Buildertrend) the research documented.

---

**Bottom line:** every number in the catalogue is either inside a verified market band, or
deliberately below it with the deviation named and justified. All of it ships as
*recommended-pending-ratification*; the owner checklist in OWNER_PRICING_DECISIONS.md is the gate
before any price becomes public.
