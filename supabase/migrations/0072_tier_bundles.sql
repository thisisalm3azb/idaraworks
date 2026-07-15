-- 0072_tier_bundles (U3 four-path subscription model): seed the Medium / High
-- TIER bundles. Forward-only, expand-only — no existing table, row or applied
-- migration is modified; existing orgs (incl. Alpha Marine / TESTING) keep
-- their current plans/add-ons untouched (any conversion is an explicit owner
-- action later; the UI does display-mapping only).
--
-- A tier is a GOVERNED BUNDLE of the SAME add-on keys (never a second
-- entitlement system): selection resolves via changeAddons → set_org_addon
-- exactly like every other bundle, each member row tagged
-- source = 'bundle.tier_*'. Code mirror: src/platform/entitlements/addons.ts
-- (BUNDLES entries carrying the `tier` marker) — parity-tested.
--
--   bundle.tier_medium — the balanced small-business set:
--     members_10 + quotes_invoices + payments_ar + expenses_cashbook +
--     purchase_requests + purchase_orders
--     members sum $28 / AED 106 → priced $15 / AED 55 (−46% / −48%).
--   bundle.tier_high — ALL currently production-operational purchasable
--     modules: the full_ops fifteen + the two branding add-ons 0071 just
--     reactivated + members_10 + storage_25gb
--     members sum $75 / AED 282 → priced $39 / AED 143 (−48% / −49%).
--     Honesty check: the cheapest combination path on the same page
--     (bundle.full_ops $29 + packs $9 + branding singles $3 = $41 / AED 155)
--     stays MORE expensive — the tier is never a dominated sticker (the 0070
--     starter_ops repricing precedent). manual_process add-ons (extra_org,
--     priority_support) and credential/D1-gated/deferred items are NOT
--     tier members.
--
-- Prices are PLACEHOLDERS (is_placeholder = true), tax-exclusive, USD base +
-- AED companion, yearly = 10× monthly (two months free) — pending owner
-- ratification (docs/commercial/OWNER_PRICING_DECISIONS.md). Real payment
-- collection remains D1-gated; nothing here touches a processor.

insert into public.bundle_def (key, sort) values
  ('bundle.tier_medium', 70),
  ('bundle.tier_high', 80);

insert into public.bundle_addon (bundle_key, addon_key) values
  ('bundle.tier_medium', 'addon.members_10'),
  ('bundle.tier_medium', 'addon.quotes_invoices'),
  ('bundle.tier_medium', 'addon.payments_ar'),
  ('bundle.tier_medium', 'addon.expenses_cashbook'),
  ('bundle.tier_medium', 'addon.purchase_requests'),
  ('bundle.tier_medium', 'addon.purchase_orders'),
  ('bundle.tier_high', 'addon.quotes_invoices'),
  ('bundle.tier_high', 'addon.payments_ar'),
  ('bundle.tier_high', 'addon.expenses_cashbook'),
  ('bundle.tier_high', 'addon.purchase_requests'),
  ('bundle.tier_high', 'addon.purchase_orders'),
  ('bundle.tier_high', 'addon.goods_receiving'),
  ('bundle.tier_high', 'addon.items_catalogue'),
  ('bundle.tier_high', 'addon.approval_workflows'),
  ('bundle.tier_high', 'addon.job_costing'),
  ('bundle.tier_high', 'addon.labour_timesheets'),
  ('bundle.tier_high', 'addon.quote_vs_actual'),
  ('bundle.tier_high', 'addon.owner_digest'),
  ('bundle.tier_high', 'addon.customer_updates'),
  ('bundle.tier_high', 'addon.data_import'),
  ('bundle.tier_high', 'addon.audit_history'),
  ('bundle.tier_high', 'addon.branding_docs'),
  ('bundle.tier_high', 'addon.branding_app'),
  ('bundle.tier_high', 'addon.members_10'),
  ('bundle.tier_high', 'addon.storage_25gb');

insert into public.bundle_price (bundle_key, billing_interval, currency, unit_amount_minor, is_placeholder)
select v.bundle_key, i.interval, c.currency,
       case
         when c.currency = 'USD' and i.interval = 'month' then v.usd
         when c.currency = 'USD' and i.interval = 'year'  then v.usd * 10
         when c.currency = 'AED' and i.interval = 'month' then v.aed
         else v.aed * 10
       end,
       true
from (values
  ('bundle.tier_medium', 1500, 5500),
  ('bundle.tier_high', 3900, 14300)
) as v(bundle_key, usd, aed)
cross join (values ('month'), ('year')) as i(interval)
cross join (values ('USD'), ('AED')) as c(currency);
