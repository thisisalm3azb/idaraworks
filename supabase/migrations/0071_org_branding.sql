-- 0071_org_branding — U2 "Organization branding": ONE governed branding source
-- per org (logo pointer, accent colour, display/legal names, document footer)
-- + the HONESTY REVERSAL of 0070 for the two branding add-ons: the capability
-- now EXISTS (validated + re-encoded logo upload, in-app header placement, PDF
-- logo slots on LPO / quote / invoice templates), so addon.branding_docs and
-- addon.branding_app return to the purchasable catalogue with fresh v2 price
-- rows (the 0070-deactivated v1 rows stay inactive — prices are versioned,
-- never reactivated). Forward-only, expand-only. Mirrors
-- src/platform/entitlements/addons.ts (DB ⇔ code parity is integration-tested).

-- ── 1. org_branding: one row per org (tenant-managed via config.manage) ──────
create table public.org_branding (
  org_id uuid primary key references public.org (id) on delete restrict,
  -- The logo is a normal tenant file-pipeline row (re-encoded server-side,
  -- org-scoped, never hard-deleted); removing the logo clears this pointer only.
  logo_file_id uuid references public.file (id) on delete restrict,
  accent_color text check (accent_color is null or accent_color ~ '^#[0-9a-fA-F]{6}$'),
  display_name text check (display_name is null or length(display_name) between 1 and 120),
  legal_name text check (legal_name is null or length(legal_name) between 1 and 200),
  footer_details text check (footer_details is null or length(footer_details) <= 500),
  updated_at timestamptz not null default now()
);

alter table public.org_branding enable row level security;

-- Tenant-scoped read/write (the app_settings/0001 idiom); DELETE is never
-- granted (no-hard-delete law — branding is cleared by nulling columns).
create policy org_branding_tenant_isolation on public.org_branding
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));

grant select, insert, update on public.org_branding to app_user;

create trigger org_branding_touch_updated_at
  before update on public.org_branding
  for each row execute function app.set_updated_at();

-- ── 2. Honesty reversal of 0070 (branding only) ──────────────────────────────
-- 0070 deferred these because no branding capability existed anywhere. This
-- migration ships WITH the capability (enforced at real hasFeature call sites —
-- the enforcement-parity test pins that), so the add-ons are honestly sellable
-- again. addon.exports_extended stays deferred — nothing changed there.
update public.addon_def
set availability = 'available'
where key in ('addon.branding_docs', 'addon.branding_app');

-- Fresh v2 ACTIVE price rows (owner anchors: $2 / $1 per month; AED companions
-- 8 / 4; yearly = 10× monthly, i.e. two months free). The 0070-deactivated v1
-- rows remain inactive history. is_placeholder = true pending owner
-- ratification (docs/commercial/OWNER_PRICING_DECISIONS.md).
insert into public.addon_price
  (addon_key, billing_interval, currency, unit_amount_minor, is_placeholder, version)
values
  ('addon.branding_docs', 'month', 'USD',   200, true, 2),
  ('addon.branding_docs', 'year',  'USD',  2000, true, 2),
  ('addon.branding_docs', 'month', 'AED',   800, true, 2),
  ('addon.branding_docs', 'year',  'AED',  8000, true, 2),
  ('addon.branding_app',  'month', 'USD',   100, true, 2),
  ('addon.branding_app',  'year',  'USD',  1000, true, 2),
  ('addon.branding_app',  'month', 'AED',   400, true, 2),
  ('addon.branding_app',  'year',  'AED',  4000, true, 2);

-- Bundle membership is NOT restored here: 0070 removed the branding add-ons
-- from bundle.starter_ops / bundle.full_ops and repriced those honestly;
-- re-adding them is a commercial (owner) decision, not an engineering reversal.
