-- 0065_addon_model (post-MVP expansion): the modular monthly add-on model.
-- Forward-only, expand-only. EXTENDS the 0005/0052 plan/entitlement/price-book
-- system — no existing table or applied migration is modified.
--
-- Contents:
--   1. New entitlement_def keys (finer-grained module caps + behaviour feats)
--   2. The `free` plan (the permanent post-trial landing base) + seeds
--   3. addon_def / addon_price   (catalogue + versioned price book, code-parity)
--   4. org_addon                 (tenant-READ-only; DEFINER-only writes)
--   5. bundle_def / bundle_addon / bundle_price (bundle = discounted collection
--      resolving to the SAME addon keys — never a second entitlement system)
--   6. app.set_org_addon         (SECURITY DEFINER, platform-task-guarded — the
--      sole writer; client claims can never activate paid entitlements)
--
-- Prices are PLACEHOLDERS (is_placeholder=true) — the recommended launch
-- catalogue pending owner ratification (OWNER_PRICING_DECISIONS.md). Tax-exclusive.
-- Real payment collection remains D1-gated; nothing here touches a processor.

-- ── 1. New entitlement keys (mirrors src/platform/entitlements/catalogue.ts) ──
insert into public.entitlement_def (key, kind) values
  ('cap.payments','feature'), ('cap.expenses','feature'), ('cap.costing','feature'),
  ('cap.attendance','feature'), ('cap.material_requests','feature'),
  ('cap.purchase_orders','feature'), ('cap.goods_receipts','feature'), ('cap.items','feature'),
  ('feat.quote_vs_actual','feature'), ('feat.owner_digest','feature'),
  ('feat.data_import','feature'), ('feat.exports_extended','feature'),
  ('feat.branding_docs','feature'), ('feat.branding_app','feature');

-- Legacy tiers stay FULL-FEATURED (existing orgs' behaviour unchanged): enable
-- every new feature key on starter/growth/business.
insert into public.plan_entitlement (plan_key, entitlement_key, enabled)
select p.key, e.key, true
from public.plan p
join public.entitlement_def e on e.key in (
  'cap.payments','cap.expenses','cap.costing','cap.attendance','cap.material_requests',
  'cap.purchase_orders','cap.goods_receipts','cap.items','feat.quote_vs_actual',
  'feat.owner_digest','feat.data_import','feat.exports_extended','feat.branding_docs',
  'feat.branding_app'
)
where p.key in ('starter','growth','business');

-- ── 2. The free plan (sort 0 — below every paid tier) ────────────────────────
insert into public.plan (key, name, sort_order) values ('free','Free',0);

-- Free FEATURES: the useful free base — jobs, daily reports, issues, customers,
-- suppliers/people records, terminology, custom fields, deterministic
-- onboarding. Paid modules OFF (activated via add-ons).
insert into public.plan_entitlement (plan_key, entitlement_key, enabled)
select 'free', e.key,
  e.key in (
    'cap.jobs','cap.daily_reports','cap.issues','cap.customers','cap.people',
    'feat.ai_onboarding','feat.ai_drafts','feat.custom_fields',
    'feat.org_terminology_overrides'
  )
from public.entitlement_def e
where e.kind = 'feature';

-- Free LIMITS: employee RECORDS are unrestricted (people are rows, not seats);
-- login seats are the lever — 3 office users, field seats free/unlimited,
-- 3 read-only viewers. Small storage; deterministic onboarding stays capped.
insert into public.plan_entitlement (plan_key, entitlement_key, limit_value) values
  ('free','limit.full_users',3),
  ('free','limit.field_users',null),
  ('free','limit.viewer_users',3),
  ('free','limit.active_jobs',10),
  ('free','limit.storage_gb',1),
  ('free','limit.ai_credits_month',0),
  ('free','limit.custom_fields_per_entity',5),
  ('free','limit.presets',15);
-- limit.ai_onboarding_calls was seeded per-plan in 0050 for the 3 tiers only:
insert into public.plan_entitlement (plan_key, entitlement_key, limit_value) values
  ('free','limit.ai_onboarding_calls',30);

-- ── 3. addon_def: the catalogue (code-parity with entitlements/addons.ts) ────
create table public.addon_def (
  key text primary key check (key ~ '^addon\.[a-z0-9_]{1,40}$'),
  -- Honesty classification (tested): deferred is NEVER purchasable.
  availability text not null check (availability in
    ('available','manual_process','credential_gated','d1_gated','deferred')),
  stackable boolean not null default false,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.addon_def enable row level security;
create policy addon_def_read on public.addon_def for select to app_user using (true);
grant select on public.addon_def to app_user;

insert into public.addon_def (key, availability, stackable, sort) values
  ('addon.members_10','available',true,10),
  ('addon.extra_org','manual_process',true,20),
  ('addon.storage_25gb','available',true,30),
  ('addon.quotes_invoices','available',false,40),
  ('addon.payments_ar','available',false,50),
  ('addon.expenses_cashbook','available',false,60),
  ('addon.purchase_requests','available',false,70),
  ('addon.purchase_orders','available',false,80),
  ('addon.goods_receiving','available',false,90),
  ('addon.items_catalogue','available',false,100),
  ('addon.approval_workflows','available',false,110),
  ('addon.job_costing','available',false,120),
  ('addon.labour_timesheets','available',false,130),
  ('addon.quote_vs_actual','available',false,140),
  ('addon.owner_digest','available',false,150),
  ('addon.customer_updates','available',false,160),
  ('addon.data_import','available',false,170),
  ('addon.exports_extended','available',false,180),
  ('addon.audit_history','available',false,190),
  ('addon.branding_docs','available',false,200),
  ('addon.branding_app','available',false,210),
  ('addon.priority_support','manual_process',false,220),
  ('addon.automation_workers','credential_gated',false,230),
  ('addon.email_notifications','credential_gated',false,240),
  ('addon.ai_pack','credential_gated',false,250),
  ('addon.oauth_login','credential_gated',false,260),
  ('addon.inventory_stock','deferred',false,300),
  ('addon.multi_location','deferred',false,310),
  ('addon.multi_currency','deferred',false,320),
  ('addon.whatsapp_pack','deferred',false,330),
  ('addon.api_webhooks','deferred',false,340);

-- ── addon_price: versioned per (addon × interval × currency), like plan_price ─
create table public.addon_price (
  id uuid primary key default gen_random_uuid(),
  addon_key text not null references public.addon_def (key) on delete restrict,
  billing_interval text not null check (billing_interval in ('month','year')),
  currency char(3) not null,
  unit_amount_minor bigint not null check (unit_amount_minor >= 0),
  provider_price_id text check (provider_price_id is null or length(provider_price_id) between 1 and 200),
  is_placeholder boolean not null default true,
  active boolean not null default true,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index addon_price_active_uq
  on public.addon_price (addon_key, billing_interval, currency)
  where active;
create index addon_price_lookup_idx on public.addon_price (addon_key, active);
alter table public.addon_price enable row level security;
create policy addon_price_read on public.addon_price for select to app_user using (true);
grant select on public.addon_price to app_user;
create trigger addon_price_touch_updated_at
  before update on public.addon_price
  for each row execute function app.set_updated_at();

-- Recommended launch prices (tax-exclusive; USD base + AED companion; yearly =
-- 10× monthly i.e. two months free). Deferred add-ons get NO price rows.
insert into public.addon_price (addon_key, billing_interval, currency, unit_amount_minor, is_placeholder)
select v.addon_key, i.interval,
       c.currency,
       case
         when c.currency = 'USD' and i.interval = 'month' then v.usd
         when c.currency = 'USD' and i.interval = 'year'  then v.usd * 10
         when c.currency = 'AED' and i.interval = 'month' then v.aed
         else v.aed * 10
       end,
       true
from (values
  ('addon.members_10',500,1900), ('addon.extra_org',900,3300), ('addon.storage_25gb',400,1500),
  ('addon.quotes_invoices',500,1900), ('addon.payments_ar',500,1900), ('addon.expenses_cashbook',400,1500),
  ('addon.purchase_requests',400,1500), ('addon.purchase_orders',500,1900), ('addon.goods_receiving',300,1100),
  ('addon.items_catalogue',300,1100), ('addon.approval_workflows',400,1500), ('addon.job_costing',700,2600),
  ('addon.labour_timesheets',500,1900), ('addon.quote_vs_actual',300,1100), ('addon.owner_digest',500,1900),
  ('addon.customer_updates',300,1100), ('addon.data_import',300,1100), ('addon.exports_extended',300,1100),
  ('addon.audit_history',400,1500), ('addon.branding_docs',200,800), ('addon.branding_app',100,400),
  ('addon.priority_support',900,3300), ('addon.automation_workers',500,1900),
  ('addon.email_notifications',300,1100), ('addon.ai_pack',600,2200), ('addon.oauth_login',300,1100)
) as v(addon_key, usd, aed)
cross join (values ('month'), ('year')) as i(interval)
cross join (values ('USD'), ('AED')) as c(currency);

-- ── 4. org_addon: an org's active add-ons (tenant-READ-only) ─────────────────
-- Rows are never deleted (downgrade = status flip; audit-friendly history).
create table public.org_addon (
  org_id uuid not null references public.org (id) on delete restrict,
  addon_key text not null references public.addon_def (key) on delete restrict,
  quantity int not null default 1 check (quantity >= 1),
  status text not null default 'active' check (status in ('active','removal_scheduled','removed')),
  source text not null default 'individual'
    check (source = 'individual' or source ~ '^bundle\.[a-z0-9_]{1,40}$'),
  added_at timestamptz not null default now(),
  -- Period-end removal deadline (downgrades apply at period end, never delete data).
  remove_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (org_id, addon_key)
);
create index org_addon_sweep_idx on public.org_addon (status, remove_at);
alter table public.org_addon enable row level security;
-- Tenant sees its own add-ons; NO tenant write path of any kind — the DEFINER
-- below is the sole writer (client claims can never activate paid entitlements).
create policy org_addon_read on public.org_addon for select to app_user
  using (org_id = app.current_org_id());
grant select on public.org_addon to app_user;
create trigger org_addon_touch_updated_at
  before update on public.org_addon
  for each row execute function app.set_updated_at();

-- ── 5. Bundles: discounted collections of the SAME addon keys ────────────────
create table public.bundle_def (
  key text primary key check (key ~ '^bundle\.[a-z0-9_]{1,40}$'),
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.bundle_def enable row level security;
create policy bundle_def_read on public.bundle_def for select to app_user using (true);
grant select on public.bundle_def to app_user;

create table public.bundle_addon (
  bundle_key text not null references public.bundle_def (key) on delete restrict,
  addon_key text not null references public.addon_def (key) on delete restrict,
  quantity int not null default 1 check (quantity >= 1),
  primary key (bundle_key, addon_key)
);
alter table public.bundle_addon enable row level security;
create policy bundle_addon_read on public.bundle_addon for select to app_user using (true);
grant select on public.bundle_addon to app_user;

create table public.bundle_price (
  id uuid primary key default gen_random_uuid(),
  bundle_key text not null references public.bundle_def (key) on delete restrict,
  billing_interval text not null check (billing_interval in ('month','year')),
  currency char(3) not null,
  unit_amount_minor bigint not null check (unit_amount_minor >= 0),
  provider_price_id text check (provider_price_id is null or length(provider_price_id) between 1 and 200),
  is_placeholder boolean not null default true,
  active boolean not null default true,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index bundle_price_active_uq
  on public.bundle_price (bundle_key, billing_interval, currency)
  where active;
alter table public.bundle_price enable row level security;
create policy bundle_price_read on public.bundle_price for select to app_user using (true);
grant select on public.bundle_price to app_user;
create trigger bundle_price_touch_updated_at
  before update on public.bundle_price
  for each row execute function app.set_updated_at();

insert into public.bundle_def (key, sort) values
  ('bundle.starter_ops',10), ('bundle.finance',20), ('bundle.procurement',30),
  ('bundle.project_control',40), ('bundle.growth',50), ('bundle.full_ops',60);

insert into public.bundle_addon (bundle_key, addon_key) values
  ('bundle.starter_ops','addon.quotes_invoices'),
  ('bundle.starter_ops','addon.customer_updates'),
  ('bundle.starter_ops','addon.branding_docs'),
  ('bundle.finance','addon.payments_ar'),
  ('bundle.finance','addon.expenses_cashbook'),
  ('bundle.finance','addon.quote_vs_actual'),
  ('bundle.procurement','addon.purchase_requests'),
  ('bundle.procurement','addon.purchase_orders'),
  ('bundle.procurement','addon.goods_receiving'),
  ('bundle.procurement','addon.items_catalogue'),
  ('bundle.procurement','addon.approval_workflows'),
  ('bundle.project_control','addon.job_costing'),
  ('bundle.project_control','addon.labour_timesheets'),
  ('bundle.project_control','addon.quote_vs_actual'),
  ('bundle.project_control','addon.owner_digest'),
  ('bundle.growth','addon.quotes_invoices'),
  ('bundle.growth','addon.payments_ar'),
  ('bundle.growth','addon.expenses_cashbook'),
  ('bundle.growth','addon.job_costing'),
  ('bundle.growth','addon.customer_updates'),
  ('bundle.full_ops','addon.quotes_invoices'),
  ('bundle.full_ops','addon.payments_ar'),
  ('bundle.full_ops','addon.expenses_cashbook'),
  ('bundle.full_ops','addon.purchase_requests'),
  ('bundle.full_ops','addon.purchase_orders'),
  ('bundle.full_ops','addon.goods_receiving'),
  ('bundle.full_ops','addon.items_catalogue'),
  ('bundle.full_ops','addon.approval_workflows'),
  ('bundle.full_ops','addon.job_costing'),
  ('bundle.full_ops','addon.labour_timesheets'),
  ('bundle.full_ops','addon.quote_vs_actual'),
  ('bundle.full_ops','addon.owner_digest'),
  ('bundle.full_ops','addon.customer_updates'),
  ('bundle.full_ops','addon.data_import'),
  ('bundle.full_ops','addon.exports_extended'),
  ('bundle.full_ops','addon.audit_history'),
  ('bundle.full_ops','addon.branding_docs'),
  ('bundle.full_ops','addon.branding_app');

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
  ('bundle.starter_ops',900,3300), ('bundle.finance',900,3300), ('bundle.procurement',1200,4500),
  ('bundle.project_control',1200,4500), ('bundle.growth',1900,7000), ('bundle.full_ops',2900,10900)
) as v(bundle_key, usd, aed)
cross join (values ('month'), ('year')) as i(interval)
cross join (values ('USD'), ('AED')) as c(currency);

-- ── 6. app.set_org_addon: the SOLE writer for org_addon ──────────────────────
-- SECURITY DEFINER + platform-task guard (same wall as app.advance_subscription):
-- callable only from a no-tenant-context platform connection (webhook processor /
-- lifecycle worker). A tenant session cannot reach it, so client claims can
-- never activate a paid entitlement. Upsert semantics; rows never deleted.
create or replace function app.set_org_addon(
  p_org_id uuid,
  p_addon_key text,
  p_quantity int,
  p_status text,
  p_remove_at timestamptz,
  p_source text
) returns void
language plpgsql
security definer
set search_path = public, app
as $$
begin
  perform app.assert_platform_task();
  if p_status not in ('active','removal_scheduled','removed') then
    raise exception 'invalid org_addon status %', p_status;
  end if;
  if not exists (select 1 from public.addon_def d where d.key = p_addon_key and d.active) then
    raise exception 'unknown or inactive addon %', p_addon_key;
  end if;
  -- Deferred capabilities can never be activated — honesty enforced at the wall.
  if p_status <> 'removed' and exists (
    select 1 from public.addon_def d where d.key = p_addon_key and d.availability = 'deferred'
  ) then
    raise exception 'addon % is deferred and cannot be activated', p_addon_key;
  end if;
  insert into public.org_addon (org_id, addon_key, quantity, status, remove_at, source)
  values (p_org_id, p_addon_key, greatest(coalesce(p_quantity, 1), 1), p_status, p_remove_at,
          coalesce(p_source, 'individual'))
  on conflict (org_id, addon_key) do update
    set quantity = excluded.quantity,
        status = excluded.status,
        remove_at = excluded.remove_at,
        source = excluded.source,
        updated_at = now();
end;
$$;
grant execute on function app.set_org_addon(uuid, text, int, text, timestamptz, text) to app_user;
