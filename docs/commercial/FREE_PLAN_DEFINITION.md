# Free Plan Definition — The Permanent Free Base

> **Source of truth:** migration `supabase/migrations/0065_addon_model.sql` (plan key `free`,
> sort 0) and `src/platform/entitlements/catalogue.ts` (`TRIAL_LANDING_PLAN = "free"`).
> The free plan is the **permanent post-trial landing base** — a real, useful product, not a
> crippled demo. Paid capability arrives via add-ons, never via tier upgrades.
> The three legacy tiers (starter/growth/business) stay seeded full-featured for existing orgs and
> internal use but are no longer the customer-facing model.

## Features — exactly as seeded in 0065

Free = ON for the core operations loop; every paid module OFF (activated by its add-on):

| Feature key | Free | If OFF, activated by |
|---|---|---|
| `cap.jobs` | ✅ ON | — |
| `cap.daily_reports` | ✅ ON | — |
| `cap.issues` | ✅ ON | — |
| `cap.customers` | ✅ ON | — |
| `cap.people` (employee/supplier records) | ✅ ON | — |
| `feat.ai_onboarding` (deterministic engine) | ✅ ON | — |
| `feat.ai_drafts` | ✅ ON | — |
| `feat.custom_fields` | ✅ ON | — |
| `feat.org_terminology_overrides` | ✅ ON | — |
| `cap.quoting`, `cap.invoicing` | ❌ off | `addon.quotes_invoices` |
| `cap.payments` | ❌ off | `addon.payments_ar` |
| `cap.expenses` | ❌ off | `addon.expenses_cashbook` |
| `cap.material_requests` | ❌ off | `addon.purchase_requests` |
| `cap.purchase_orders` | ❌ off | `addon.purchase_orders` |
| `cap.goods_receipts` | ❌ off | `addon.goods_receiving` |
| `cap.items` | ❌ off | `addon.items_catalogue` |
| `cap.approvals` | ❌ off | `addon.approval_workflows` |
| `cap.costing` | ❌ off | `addon.job_costing` |
| `cap.attendance` | ❌ off | `addon.labour_timesheets` |
| `cap.customer_updates` | ❌ off | `addon.customer_updates` |
| `feat.quote_vs_actual` | ❌ off | `addon.quote_vs_actual` |
| `feat.owner_digest` | ❌ off | `addon.owner_digest` |
| `feat.data_import` | ❌ off | `addon.data_import` |
| `feat.exports_extended` | ❌ off | `addon.exports_extended` — **core record exports always remain free** |
| `feat.audit_export` | ❌ off | `addon.audit_history` |
| `feat.branding_docs` / `feat.branding_app` | ❌ off | `addon.branding_docs` / `addon.branding_app` |
| `feat.ai_narration` | ❌ off | `addon.ai_pack` (credential-gated) |

(0065 seeds `enabled` for every `entitlement_def` of kind `feature`, true only for the ON list —
so any feature not listed above is off on free by construction.)

## Limits — exactly as seeded in 0065

| Limit key | Free value | Meaning |
|---|---|---|
| `limit.full_users` | **3** | office login seats |
| `limit.field_users` | **null = unlimited** | field/foreman login seats — always free |
| `limit.viewer_users` | **3** | read-only login seats |
| `limit.active_jobs` | **10** | concurrently active jobs |
| `limit.storage_gb` | **1** | document/photo storage |
| `limit.ai_credits_month` | **0** | AI credits (deterministic engine unaffected) |
| `limit.custom_fields_per_entity` | **5** | custom fields |
| `limit.presets` | **15** | configuration presets |
| `limit.ai_onboarding_calls` | **30** | deterministic-onboarding call cap |

Limits are lifted by stackable add-ons as ADDED deltas (× quantity): `addon.members_10`
(+10 full + 10 viewer seats), `addon.storage_25gb` (+25 GB), `addon.ai_pack` (+200 AI credits/mo).

## Employee RECORDS vs login SEATS — the critical distinction

- **Employee records are unlimited on free.** People are *rows*, not seats: an org can register its
  entire workforce (attendance subjects, crew assignment, cost records) at no charge, forever.
  There is no `limit` key on people records at all.
- **Login seats are the lever**, split three ways:
  - **Office seats** (`limit.full_users`): 3 free; grow in packs of 10 via `addon.members_10`.
  - **Field seats** (`limit.field_users`): **unlimited and free, always** — foremen and crews on
    phones are the product's point; charging for them is the pattern this market hates most.
  - **Viewer seats** (`limit.viewer_users`): 3 free read-only logins (accountant, owner's partner).

## The trial model

Per `catalogue.ts`: `DEFAULT_PLAN = "growth"`, `TRIAL_LANDING_PLAN = "free"`.

1. **Every new org starts on a 14-day full-featured Growth trial** — the complete platform, no
   card required, so onboarding can configure modules the org will later buy.
2. **At trial end the org lands on `free` — never suspension.** Data, jobs, reports and records
   remain fully accessible within free limits; paid-module data becomes read-only-visible rather
   than deleted. The free base is real, so "trial expired" is a downgrade, not a lockout.
3. Buying any add-on (or bundle) at any time re-lights exactly the purchased capabilities on top of
   the free base (`resolve.ts` layering).

## Research justification for each limit

Benchmarks from [ADDON_MARKET_RESEARCH.md](./ADDON_MARKET_RESEARCH.md) (official pages, 2026-07-15):

| Our free choice | Benchmark |
|---|---|
| 3 office seats | More generous than the verified norm of 1–2 free users (Zoho Books 1 + accountant; Zoho Invoice 2; monday.com 2 seats) |
| Unlimited free field seats | The Odoo pattern ("one app free, **unlimited users**") adapted vertically; unlimited users is also the norm across field/ops vendors (ServiceM8 paid tiers, Xero, Procore, Buildertrend, AgriWebb) |
| 3 viewers | monday.com gives unlimited *viewers* only from its paid Basic tier — 3 free viewers on a free plan is at-market |
| 10 active jobs | ServiceM8 Free allows 30 *jobs/month*; monday Free allows 3 boards — an active-jobs cap in this range is the norm shape for ops tools |
| 1 GB storage | Far above ClickUp Free's 60MB and Notion's 5MB/file — storage is a proven, accepted free gate and 1 GB is generous within it |
| Unlimited records | Wave (unlimited invoices/bills/records) and ClickUp (unlimited tasks) prove unlimited records is a viable free wedge; Zoho's 500–1,000 docs/yr is the stingier alternative we beat |
| Core exports never gated | **No researched vendor gates exports on free** — gating exports reads as data hostage-taking; we gate seats, modules and storage instead |
| Free tier at all (vs trial-only) | Every verified GCC competitor (Zoho SA/AE, Qoyod, Daftra, Mezan) offers a free tier or no-card trial — table stakes |
| 14-day full trial → free landing | 14-day no-card trials are the field-service norm (Jobber, ServiceM8, Farmbrite); landing on a real free plan instead of suspension follows the Odoo/Wave/ClickUp free-forever pattern |
| 0 AI credits (deterministic engine free) | ClickUp/monday meter AI by credits on top of plans; our deterministic engine stays free with AI enrichment as the credential-gated `addon.ai_pack` |
