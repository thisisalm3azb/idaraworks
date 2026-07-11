-- 0001_org_core
-- S0 checklist §3 migration 0001: org, company, app_settings, org_holiday_calendar,
-- currency_rate_default. Every tenant table: RLS enabled + tenant policy in this
-- same file (phase2/10 #2), init-plan-wrapped GUC reads (phase2/10 #1).
-- Grants: NO DELETE on any table (D-1.7 archive/void law, enforced at grant level).
-- Rollback note: drop tables in reverse order; safe only while no tenant data exists.

-- ── org (the tenant root; policy keys on id, not org_id) ─────────────────────
create table public.org (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country char(2) not null,
  timezone text not null default 'Asia/Dubai',
  base_currency char(3) not null
    check (base_currency in ('AED','SAR','QAR','KWD','BHD','OMR','USD','EUR')),
  languages text[] not null default array['en'],
  -- Working week set at onboarding, country-aware defaults (audit C-4).
  working_week jsonb not null default '{"days": ["mon","tue","wed","thu","fri"]}',
  phone_login_enabled boolean not null default false, -- OP-6: per-org phone login
  report_cutoff_time time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.org enable row level security;

create policy org_tenant_isolation on public.org
  for all to app_user
  using (id = (select app.current_org_id()))
  with check (id = (select app.current_org_id()));

-- No INSERT grant: org creation is a platform action (Phase C bootstrap path).
grant select, update on public.org to app_user;

create trigger org_touch_updated_at
  before update on public.org
  for each row execute function app.set_updated_at();

-- ── company (legal entity; data-model-ready, single-company UI in MVP) ───────
create table public.company (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name text not null,
  is_default boolean not null default true,
  tax_reg_no text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index company_org_idx on public.company (org_id);

alter table public.company enable row level security;

create policy company_tenant_isolation on public.company
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));

grant select, insert, update on public.company to app_user;

create trigger company_touch_updated_at
  before update on public.company
  for each row execute function app.set_updated_at();

-- ── app_settings (org key-value incl. capability go-live cutoffs,
--    Ramadan working-hours profile, report cutoff overrides) ─────────────────
create table public.app_settings (
  org_id uuid not null references public.org (id) on delete restrict,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, key)
);

alter table public.app_settings enable row level security;

create policy app_settings_tenant_isolation on public.app_settings
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));

grant select, insert, update on public.app_settings to app_user;

create trigger app_settings_touch_updated_at
  before update on public.app_settings
  for each row execute function app.set_updated_at();

-- ── org_holiday_calendar (template-seeded per country, org-editable — F-41) ──
create table public.org_holiday_calendar (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  starts_on date not null,
  ends_on date,
  label jsonb not null, -- {en: "...", ar: "..."}
  kind text not null check (kind in ('public_holiday', 'eid', 'org')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on)
);

create index org_holiday_calendar_org_date_idx
  on public.org_holiday_calendar (org_id, starts_on);

alter table public.org_holiday_calendar enable row level security;

create policy org_holiday_calendar_tenant_isolation on public.org_holiday_calendar
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));

grant select, insert, update on public.org_holiday_calendar to app_user;

create trigger org_holiday_calendar_touch_updated_at
  before update on public.org_holiday_calendar
  for each row execute function app.set_updated_at();

-- ── currency_rate_default (org-editable default FX table — OP-8) ─────────────
create table public.currency_rate_default (
  org_id uuid not null references public.org (id) on delete restrict,
  currency char(3) not null
    check (currency in ('AED','SAR','QAR','KWD','BHD','OMR','USD','EUR')),
  rate_to_base numeric(18, 8) not null check (rate_to_base > 0),
  updated_at timestamptz not null default now(),
  primary key (org_id, currency)
);

alter table public.currency_rate_default enable row level security;

create policy currency_rate_default_tenant_isolation on public.currency_rate_default
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));

grant select, insert, update on public.currency_rate_default to app_user;

create trigger currency_rate_default_touch_updated_at
  before update on public.currency_rate_default
  for each row execute function app.set_updated_at();
