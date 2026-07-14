# Add-on Market Research — 2026 SaaS Pricing Sweep

> **Status:** research record. All figures were captured from **official pricing pages** on
> **2026-07-15** by a fan-out research run (17 products, 23 agents, adversarial verification pass).
> Prices are recorded **exactly as displayed** at access time; SaaS prices change frequently
> (Intuit has already announced Aug 2026 increases). Every product carries a `verified` flag —
> **an unverified figure is never presented as fact** in any downstream document.
>
> Downstream: [ADDON_PRICING_RATIONALE.md](./ADDON_PRICING_RATIONALE.md),
> [OWNER_PRICING_DECISIONS.md](./OWNER_PRICING_DECISIONS.md).

## Verification summary

| Product | Verified | Caveat |
|---|---|---|
| Odoo | ✅ true | GCC regional rate NOT verifiable (US page only) |
| Zoho (One / Books / Inventory) | ✅ true | Zoho One monthly-billing USD rates and Essentials plan price unverified |
| QuickBooks Online | ✅ true (via rendered browser; direct fetch bot-blocked) | Solopreneur price unverified; payroll standalone delta derived, not displayed |
| Xero | ✅ true (page HTML via curl; WebFetch 503-blocked) | Projects/Expenses/payroll per-unit prices not on page |
| FreshBooks | ✅ true | Exact yearly-billing dollar figures not rendered — computed, not displayed |
| Monday.com | ✅ true | Monthly-billing (non-annual) rates from third parties only |
| ClickUp | ✅ true | Billed-monthly rates ($10/$19) from search snippets, unverified |
| Jobber | ✅ true | One fetch pass had anomalous rows, treated as extraction noise |
| ServiceM8 | ✅ true | — |
| Shopify | ✅ true | Starter ($5/mo) and Retail plans not shown, excluded; card rates geo-rendered |
| Katana | ✅ true | Annual rate, Shop Floor add-on and extra-location prices not displayed |
| Cin7 | ✅ true (base plans only) | ALL add-on prices quote-gated; billing term unverified |
| MRPeasy | ✅ true | — |
| **Procore** | ❌ **false** | Quote-only wall; every dollar figure is third-party |
| Buildertrend | ✅ true (model only) | No prices published; all dollar figures third-party/unverified |
| Farmbrite | ✅ true | — |
| **AgriWebb** | ❌ **false** (plan prices) | JS calculator, no static prices; add-on prices ARE verified via official help center |

**Why the failures:** Procore's official page confirms only the pricing *model* (ACV-based,
unlimited users, per-product modular quotes) — no dollar figure appears anywhere official.
AgriWebb renders prices client-side from a livestock-count calculator, so tier prices could not
be captured; only its help-center add-on prices ($100–300/yr planners) are official.
Xero and QuickBooks required workarounds (curl / rendered browser) due to bot protection, but the
figures below **are** from official page content. Where a specific sub-figure could not be
verified it is marked inline.

---

## Product records

### 1. Odoo — modular business apps / ERP suite
- **Source:** https://www.odoo.com/pricing — accessed 2026-07-15 — **verified: true** (two independent fetches, identical figures)
- **Plans:** One App Free $0 (1 app, **unlimited users**); Standard $28.80/user/mo monthly, $22.80/user/mo annual (ALL apps); Custom $44.00 monthly, $35.20/user/mo annual (adds Studio, multi-company, external API)
- **Free tier:** One App Free — $0 forever, any single app, unlimited users; installing a second app moves ALL users to paid
- **Add-on pricing:** Odoo does **not** price per module — one flat per-user fee unlocks all ~70 apps. Paid extras: Odoo.sh hosting, Success Packs (services), metered IAP credits (SMS, OCR, lead gen)
- **Per-seat model:** strictly per named internal user; portal/external users free and unlimited
- **Target market:** SMB through mid-market, global
- **Regional:** geo-priced by country; USD figures are the US list. GCC has a historically lower tier (~$13.50/user/mo per community sources) — **GCC rate UNVERIFIED**
- **Notably:** API access is gated to Custom tier — effectively a ~$15/user/mo premium capability

### 2. Zoho One + Zoho Books + Zoho Inventory
- **Sources:** zoho.com/one/pricing/, /r/small-teams/pricing/, /us/books/pricing/, /us/inventory/pricing/ — 2026-07-15 — **verified: true** (with caveats below)
- **Zoho One:** All-Employee $37/user/mo annual (must license every employee); Flexible User $90/user/mo annual; monthly-billing USD rates NOT displayed (**~$45/~$105 implied by NZ ratios — UNVERIFIED**); Essentials plan price contact-sales only (**UNVERIFIED**)
- **Zoho Books:** Free $0 (1 user + 1 accountant, revenue < $50K/yr, 1,000 invoices + 1,000 expenses/yr); Standard $20 monthly / $15 annual (3 users); Professional $50/$40 (5 users); Premium $70/$60 (10 users); Elite $150/$120; Ultimate $275/$240 (15 users, 3M records)
- **Zoho Inventory:** Free $0 (50 orders/mo, 1 user); Standard $29; Premium $79; Plus $129; Enterprise $249 (annual-billing rates)
- **Add-on pricing (verified, annual billing):** Books extra users **$2.50/user/mo**; autoscans $8/50/mo; locations $10/mo; expense claims $7/active user/mo. Inventory extra users $7.50/user/mo; +500 orders $7.50/mo; Advanced Warehousing $124.17/mo
- **Per-seat model:** Zoho One per-user (two models); Books/Inventory flat per-org with user caps + cheap seat add-ons
- **Target market:** SMB→mid-market; strong India and MEA/GCC presence
- **Regional:** geo-served price lists by IP; account currency fixed at creation; VAT/GST added on top (UAE 5% / KSA 15%)

### 3. QuickBooks Online — accounting
- **Sources:** quickbooks.intuit.com/pricing/, /payroll/pricing/ — 2026-07-15 — **verified: true** (rendered in browser; direct fetch blocked)
- **Plans (US, monthly only — no annual billing displayed):** Simple Start $38 (1 user); Essentials $75 (3 users); Plus $115 (5 users); Advanced $275 (25 users). All with 50%-off-3-months intro or 30-day trial (mutually exclusive). Solopreneur ~$20/mo **UNVERIFIED** (third-party only)
- **Free tier:** none
- **Add-on pricing:** Payroll bundles as displayed: Workforce Payroll + Simple Start $88/mo **+ $7/employee/mo**; + Essentials $125/mo + $7/ee; Premium + Plus $203/mo **+ $13/employee/mo**. (A separate Intuit-help-sourced datapoint records per-employee fees of +$5/+$8/+$10 across Core/Premium/Elite with Active-employee billing from 15 June 2026 — help-content sourced, page fetch failed for that pass.) Many other add-ons referenced without on-page prices
- **Per-seat model:** flat per plan with hard user caps — no extra-seat price; upgrade tiers instead. Payroll is per-employee usage on top
- **Target market:** US small businesses
- **Regional:** US site only; no GCC/UAE/Saudi site in the country selector; no VAT/ZATCA support mentioned. UAE page (quickbooks.intuit.com/ae/pricing/) timed out — **UAE prices UNVERIFIED**
- **Notably:** Intuit announced further price changes effective Aug 1, 2026 — these figures may rise within weeks

### 4. Xero — accounting
- **Source:** https://www.xero.com/us/pricing-plans/ — 2026-07-15 — **verified: true** (HTML via curl; WebFetch 503-blocked)
- **Plans (US, monthly billing only):** Early $25/mo (unlimited users; 20 invoices + 5 bills/mo); Growing $55/mo (unlimited everything); Established $90/mo (adds multi-currency, Projects, Expenses, forecasting)
- **Free tier:** none — promos only
- **Add-on pricing:** Inventory Plus **$39/mo** flat add-on on any plan (verified). Page FAQ references usage charges for Payroll/Projects/Expenses without per-unit prices (**not verified on this page**; a separate search-snippet pass recorded Claim Expenses *from $4/mo* and Track Projects *from $7/mo* citing xero.com pages — flagged unverified in that pass). US payroll via Gusto, billed separately
- **Per-seat model:** flat per-organization, **unlimited users on every plan** — no per-seat pricing at all; extra org = extra subscription
- **Target market:** small businesses, solo→scaling
- **Regional:** US-edition prices, tax-exclusive; plan lineups differ by country; no GCC edition on this page — GCC availability unverified

### 5. FreshBooks — invoicing/accounting
- **Source:** https://www.freshbooks.com/pricing — 2026-07-15 — **verified: true**
- **Plans (monthly):** Lite $23 (5 billable clients); Plus $43 (50 clients); Premium $70 (unlimited); Select custom. Yearly toggle = "Extra 10% Off" (exact annual figures not displayed — computed equivalents only)
- **Free tier:** none — 30-day trial
- **Add-on pricing (verified):** Team members **$11/user/mo**; Advanced Payments $20/mo; Payroll $40/mo base + $6/user
- **Per-seat model:** hybrid — flat plan for 1 owner, limited by billable clients, extra team members per-seat
- **Target market:** freelancers and small teams
- **Regional:** USD/US page; regional pricing not verified

### 6. Monday.com — Work OS
- **Source:** https://monday.com/pricing — 2026-07-15 — **verified: true**
- **Plans (per seat, billed-annually rates):** Free $0 (2 seats, 3 boards, 3 docs); Basic $9; Standard $12; Pro $19; Enterprise custom. Monthly-billing rates ~18% higher per third parties (**UNVERIFIED**)
- **Free tier:** free forever — 2 seats, 3 boards, 3 docs, unlimited read-only viewers from Basic up
- **Add-on pricing:** separate *products* per seat (CRM $12–28, dev $9–20, service $31–45 annual rates); AI credit top-ups **~$10 per 1,000 credits**
- **Per-seat model:** per-seat in prepaid tiers, minimum seats apply, unlimited free viewers
- **Target market:** SMB→enterprise horizontal work management
- **Regional:** USD ex tax, "final amount determined by billing country"; no GCC restriction stated

### 7. ClickUp — project management
- **Source:** https://clickup.com/pricing — 2026-07-15 — **verified: true** (billed-yearly rates and AI add-ons)
- **Plans:** Free Forever $0 (unlimited tasks/members, **60MB storage**, 1 form); Unlimited $7/user/mo yearly; Business $12/user/mo yearly; Enterprise custom. Monthly rates ($10/$19) **UNVERIFIED**
- **Free tier:** unlimited members and tasks; storage is the gate (60MB)
- **Add-on pricing:** AI per-user add-ons — Brain AI $9/user/mo, Everything AI $28/user/mo; credits à la carte ~$10 per 10,000
- **Per-seat model:** per-user, workspace-wide plan (all members same tier)
- **Regional:** none stated; "$" not explicitly labelled as USD

### 8. Jobber — field service management
- **Source:** https://www.getjobber.com/pricing/ — 2026-07-15 — **verified: true** ("All prices in USD" stated on page)
- **Plans (annual-billing / 1-yr commit / month-to-month):** Core $29/$39/$49 (1 user); Connect $99/$119/$139 (5 users); Grow $149/$169/$199 (10 users); Plus $399/$439/$499 (15 users)
- **Free tier:** none — 14-day Grow-level trial
- **Add-on pricing (verified):** extra users **$29/mo each** on every tier; Marketing Suite $79/mo; AI Receptionist $29/mo; Pipeline $49/mo; payment fees 2.9%+30¢ card / 1% ACH
- **Per-seat model:** hybrid flat tier + $29 per additional seat
- **Target market:** home/field service SMBs
- **Regional:** Jobber Payments US/CA/UK only; ACH US only — **no GCC payments support**

### 9. ServiceM8 — field service management
- **Source:** https://www.servicem8.com/us/pricing — 2026-07-15 — **verified: true**
- **Plans (monthly only, no annual):** Free $0 (1 user, 30 jobs/mo); Starter $29 (50 jobs); Growing $79 (150); Premium $149 (500); Premium Plus $349 (1,500+, then 20¢/job). **Unlimited users on all paid plans**
- **Free tier:** yes — $0, 1 user, 30 jobs/mo, 10 AI uses/day
- **Add-on pricing:** Phone add-on from $19/mo; SMS 10¢; card fees 2.49–3.10%+30¢
- **Per-seat model:** usage-based (jobs/month), NOT per-seat — extra seats $0
- **Regional:** geo-localized currency; core markets AU/NZ/US/UK; no GCC mention

### 10. Shopify — e-commerce
- **Source:** https://www.shopify.com/pricing — 2026-07-15 — **verified: true** (plan prices)
- **Plans:** Basic $39/$29 annual (0 staff accounts); Grow $105/$79 (5); Advanced $399/$299 (15); Plus from $2,300/mo
- **Free tier:** none; "$1/month for 3 months" promo; Agentic option $0 base + commission
- **Add-on pricing:** POS Pro **$89/mo per location** (verified); app-store apps priced separately (not on this page). Developer docs support free/monthly/yearly/usage/hybrid app plans; third-party norm ~$58/mo typical app (**UNVERIFIED**)
- **Per-seat model:** flat per store; staff caps by tier; revenue via transaction fees (2%/1%/0.6%/0.2%)
- **Regional:** "available in nearly every country"; Shopify Payments country-limited (UAE historically yes, KSA via third-party gateways — **GCC specifics unverified**)

### 11. Katana — cloud inventory / MRP
- **Source:** https://katanamrp.com/pricing/ — 2026-07-15 — **verified: true**
- **Plans:** Free $0 (30 SKUs, unlimited users); Core from $299/mo (unlimited SKUs/users); Advantage custom
- **Add-on pricing (verified, per month):** Traceability $249; Warehouse Management $149; Manufacturing Management $199; Shop Floor price not displayed; onboarding one-time $2,000
- **Per-seat model:** flat platform fee + per-module add-ons; unlimited users — a pure **modular add-on** comparable
- **Regional:** "$" not explicitly labelled USD; no GCC mention

### 12. Cin7 — inventory management
- **Source:** https://www.cin7.com/pricing/ — 2026-07-15 — **verified: true (base plans only)**
- **Plans:** Core Standard $349/mo (5 users, 6K orders/yr); Core Pro $599 (10 users); Core Advanced $999 (15 users); Omni quote-only. Billing term (monthly vs annual contract) **not stated**
- **Add-on pricing:** an extensive add-on catalogue (Automations, IDR, ForesightAI, B2B portal, POS, Premium Support, API access) — **all quote-gated, zero published prices**. Extra users purchasable at undisclosed price
- **Per-seat model:** flat fee with bundled user counts; not pure per-seat
- **Regional:** USD ex tax, no regional variants shown

### 13. MRPeasy — cloud MRP/ERP
- **Source:** https://www.mrpeasy.com/pricing/ — 2026-07-15 — **verified: true**
- **Plans (per user/mo):** Starter $49; Professional $69; Enterprise $99; Unlimited $149 (min 2 users). Annual = 1 month free. From 11th user: **$79/mo per 10-user bundle**
- **Free tier:** none — "15 + 15 days" trial
- **Add-on pricing:** no per-module pricing — features tier-gated; paid *service* add-ons only (Advanced Support $199–579/mo, training $150/hr); API gated to Unlimited tier
- **Target market:** small manufacturers/distributors up to ~200 employees
- **Regional:** USD only, no regional variation stated

### 14. Procore — construction management — ⚠️ verified: **false**
- **Source:** https://www.procore.com/pricing — 2026-07-15 — quote-wall
- **What IS verified (from the official page):** the *model* — custom annual quote per product, priced by Annual Construction Volume (ACV); **unlimited users**; modular per-product selection; Field Productivity priced per FTE; free training and enhancements
- **What is NOT verified (third-party only, do not cite as fact):** ~$375/mo entry; ~$15k–30k/yr small GCs; ~$30k–80k/yr mid-size; ~0.1–0.2% of ACV; $50k–150k implementation; 5–14% renewal increases
- **Why unverified:** no dollar figure exists on any official Procore page (support.procore.com searched — no pricing articles)

### 15. Buildertrend — construction PM
- **Sources:** buildertrend.com/pricing/, /frequently-asked-questions/, /additional-services/ — 2026-07-15 — **verified: true for the model, false for every dollar figure**
- **Verified facts:** single custom-quote plan (former tiers retired), priced by builder type + annual construction volume; unlimited users and projects; full feature set on every plan — "no hidden add-ons"; 10% off annual prepay; no free trial
- **Unverified (historical/third-party):** Essential ~$339–499, Advanced ~$499–799, Complete ~$829–1,099/mo; onboarding ~$400–1,500
- **Regional:** 100+ countries, explicit support US/CA/AU/NZ/UK; no GCC mention

### 16. Farmbrite — farm management
- **Source:** https://www.farmbrite.com/pricing — 2026-07-15 — **verified: true**
- **Plans (monthly / annual = 10×):** Livestock $29/$49/$79; Crop $29/$39/$59; Complete $59/$79/$109; Farm Accounting standalone $119/yr; Enterprise custom
- **Free tier:** none — 14-day trial
- **Add-on pricing:** modular by *product line*, not add-on modules; no per-seat/per-record add-on prices; no setup/overage fees
- **Per-seat model:** flat per-farm; seats tier-capped (5–10 → unlimited)
- **Notably:** **annual = 10× monthly (~2 months free)** — the exact convention IdaraWorks adopts
- **Regional:** USD only; US-oriented accounting (Schedule F)

### 17. AgriWebb — livestock farm management — ⚠️ verified: **false** (plan prices)
- **Sources:** agriwebb.com/pricing/ (+ /us/), help.agriwebb.com article 8319220 — 2026-07-15
- **Why plan prices unverified:** prices render client-side from a livestock-count calculator (baseline + per-head DSE-weighted component); no static figures on any official page. Third-party baselines (~$34/$48/$61/mo, likely AUD ex GST, Jan 2026) — do not cite as fact
- **What IS verified (official help center):** add-ons — Rotational/Grazing Planner AU/NZ **$300 AUD/yr**; US/CA/MX Grazing Planner **$150 USD/yr**, Movement Planner **$100 USD/yr**; UK/IE/EU included free; Cibo Labs PastureKey from ~$1,000/yr
- **Per-seat model:** unlimited users; usage-based on livestock head count
- **Regional:** AU/NZ, US/CA/MX, UK/IE/EU, ZA; **no GCC presence**

---

## Thematic synthesis 1 — Free-tier norms 2026

Verified benchmarks (all from official pages, 2026-07-15):

| Vendor | Free tier | The gate |
|---|---|---|
| Zoho Books | 1 user + 1 accountant; 1,000 invoices + 1,000 expenses/yr; revenue < $50K/yr | seats + volume + revenue |
| Zoho Invoice | 2 users; 500 invoices/yr; "Powered by Zoho" branding | seats + volume + branding |
| Odoo | **one app, unlimited users**, free forever | module count |
| ClickUp | unlimited members and tasks; **60MB storage**; 1 form | storage |
| monday.com | 2 seats; 3 boards; 3 docs | seats + objects |
| Wave | unlimited estimates/invoices/bills/records | monetized via processing + add-ons |
| Notion | single user unlimited; 10 guests; 5MB/file; 7-day history | seats + file size |
| ServiceM8 | 1 user; 30 jobs/mo | seats + job volume |
| Katana | 30 SKUs, unlimited users | records |

**Emerging norms:** users are the dominant paywall lever — either 1–2 login users, or unlimited
users with another constraint (one module; tiny storage; job volume). Storage can be capped
aggressively (60MB!) without seeming stingy. Records/documents are either unlimited or ~500–1,000/yr.
**Export limits were NOT a free-tier gate on any page checked** — gating exports reads as hostile;
gate seats, modules, or storage instead.

## Thematic synthesis 2 — Modular / per-module pricing models

- **Odoo:** does not sell modules — flat per-user unlocks everything; the free wedge is one app. API access is the exception: gated to Custom (+~$15/user/mo)
- **Zoho:** dual model — per-app pricing OR the all-in Zoho One bundle; org-level plans with cheap per-seat add-ons ($2.50–7.50/user/mo)
- **QuickBooks:** true add-on modules with base + per-employee metering ($7/$13 per employee/mo displayed; $5/$8/$10 per Intuit help content)
- **Xero:** cheap flat feature add-ons on top of plans (Inventory Plus $39/mo verified; Expenses ~$4/mo and Projects ~$7/mo via snippets, unverified) — the **$4–10 flat small-module** pattern
- **Shopify:** platform + separately-priced app store; official billing infra supports free/recurring/usage/hybrid plans
- **Katana / Cin7:** flat platform + per-module add-ons (Katana publishes prices; Cin7 quote-gates all of them)

**Emerging price bands:** small feature modules **$4–10 flat/mo**; people-metered modules
**$5–10/user-or-employee/mo**; standalone app subscriptions $10–60/mo; "everything" bundles
**$28–45/user/mo** (Odoo Standard $28.80, Zoho One All-Employee $37) with selective-user bundles
~$90/user/mo (Zoho One Flexible). Premium capabilities (API, branding removal, priority support)
are typically gated to top tiers rather than priced individually. Annual-billed monthly rates shown
prominently with ~20–25% discount is universal.

## Thematic synthesis 3 — GCC/MENA SMB context (KSA/UAE)

Verified regional benchmarks (official pages, 2026-07-15):

- **Zoho Books KSA:** SAR 60–660/mo annual (69–799 monthly); **extra user SAR 8–10/mo**; ZATCA Phase 2 included from Standard. UAE mirrors identical numerals in AED
- **Qoyod (KSA local, tax-inclusive):** Basic 138 / Pro 207 / Advanced 379.5 SAR/mo; add-ons ex-tax: **user SAR 20/mo**, location SAR 40/mo, POS user SAR 50/mo, payroll employee SAR 10/mo; ZATCA Phase 2 included in Pro/Advanced
- **Daftra:** prices in USD even for KSA — Basic $30 / Advanced $55 / Premium $70/mo; extra user $7–9.33/mo; full ZATCA/Fatoora compliance included
- **Mezan (Saudi-built):** annual-only SAR — Invoicing 950 / Business 2,450 / Advanced 4,950 SAR/yr ex VAT; ZATCA invoicing bundled in the base plan
- **Wafeq:** pricing page unfetchable (403/404) — snippet figures SAR 69–799/mo **UNVERIFIED**, indicative only
- **QuickBooks UAE:** page timed out — **UNVERIFIED**; no KSA-localized offering surfaced

**The ZATCA finding (verified pattern across all four fetchable vendors):** ZATCA Phase 2
e-invoicing compliance is **always bundled** into standard plans — Zoho (from Standard), Qoyod
(Pro/Advanced), Daftra (all plans), Mezan (base plan). **No GCC vendor publishes e-invoicing as a
separate paid add-on. Charging separately for it would be a competitive liability.**

**Regional price bands:** entry tiers SAR/AED 60–140/mo (~$16–37); mid tiers SAR 129–240 (~$34–64);
top self-serve SAR 350–800 (~$93–213). Per-user add-ons cluster at **SAR 8–20/user/mo**. GCC table
stakes: SAR/AED-labelled pricing, ZATCA included, free tier or no-card trial. Note the tax-labelling
split: locals (Qoyod) show tax-inclusive, internationals show ex-VAT — pick one convention per
market and label it clearly.

---

## Residual gaps (critic pass)

1. **Procore** — retry the official page / support site if construction-vertical pricing becomes decision-critical; today only the model is citable.
2. **AgriWebb** — plan tiers need a calculator session to capture; add-on prices are already official.
3. Several `addOnPricing` source strings were flagged as possibly truncated in the raw dataset — figures reproduced here were cross-checked against the per-product records; Cin7's absence of add-on dollar prices is expected (quote-gated), not truncation.

All 17 target products present; every category (accounting, invoicing, PM, field service,
construction, manufacturing, inventory, e-commerce, agriculture, general ops) has at least one
verified product; add-on/per-module coverage judged OK by the critic pass.
