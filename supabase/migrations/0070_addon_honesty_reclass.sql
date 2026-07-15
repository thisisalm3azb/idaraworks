-- 0070_addon_honesty_reclass — enforcement-honesty reclassification (review:
-- "sold add-ons whose feature keys are enforced nowhere"). Forward-only; mirrors
-- src/platform/entitlements/addons.ts (parity-tested).
--
-- Findings of the enforcement audit:
--   * feat.exports_extended (addon.exports_extended): NO extended export tier
--     exists — the CSV export catalogue is the always-free core set. Buying the
--     add-on changed nothing. → deferred.
--   * feat.branding_docs / feat.branding_app (addon.branding_docs /
--     addon.branding_app): no logo/branding capability (upload, PDF logo slot,
--     theming) exists anywhere. → deferred.
--   * feat.owner_digest, cap.costing, feat.quote_vs_actual, feat.audit_export:
--     REAL boundaries exist and are now enforced in code (org-home digest card,
--     costing pages, costing margin section, audit-log export route) — those
--     add-ons stay available.
--
-- Price versioning: price rows are deactivated, never deleted.

-- ── 1. Reclassify to deferred ────────────────────────────────────────────────
update public.addon_def
set availability = 'deferred'
where key in ('addon.exports_extended', 'addon.branding_docs', 'addon.branding_app');

-- Deferred add-ons carry no active price rows (0065 invariant; parity-tested).
update public.addon_price
set active = false, updated_at = now()
where addon_key in ('addon.exports_extended', 'addon.branding_docs', 'addon.branding_app')
  and active;

-- Defensive honesty cleanup: no org is expected to hold these (no real payments
-- pre-D1), but any grant of a capability that does not exist must not persist.
-- Rows are flipped to removed, never deleted (audit-friendly history).
update public.org_addon
set status = 'removed', remove_at = null, updated_at = now()
where addon_key in ('addon.exports_extended', 'addon.branding_docs', 'addon.branding_app')
  and status <> 'removed';

-- ── 2. Bundle membership (bundles may only contain purchasable add-ons) ──────
-- bundle.starter_ops loses branding_docs; bundle.full_ops loses branding_docs,
-- branding_app and exports_extended.
delete from public.bundle_addon
where addon_key in ('addon.exports_extended', 'addon.branding_docs', 'addon.branding_app');

-- ── 3. Reprice bundle.starter_ops to keep the discount genuine ───────────────
-- Members are now quotes_invoices ($5/19 AED) + customer_updates ($3/11 AED) =
-- $8 / AED 30. The old $9 / AED 33 would have been MORE than buying the members
-- individually — dishonest. New price: $7/mo (−12.5%) / AED 26 (−13%); yearly
-- stays 10× monthly. is_placeholder = true — pending owner ratification
-- (docs/commercial/OWNER_PRICING_DECISIONS.md).
update public.bundle_price
set active = false, updated_at = now()
where bundle_key = 'bundle.starter_ops' and active;

insert into public.bundle_price
  (bundle_key, billing_interval, currency, unit_amount_minor, is_placeholder, version)
values
  ('bundle.starter_ops', 'month', 'USD', 700, true, 2),
  ('bundle.starter_ops', 'year',  'USD', 7000, true, 2),
  ('bundle.starter_ops', 'month', 'AED', 2600, true, 2),
  ('bundle.starter_ops', 'year',  'AED', 26000, true, 2);

-- bundle.full_ops keeps its $29 / AED 109 price: members now sum to $63 / AED 236
-- — still a genuine −54% discount, no reprice needed.
