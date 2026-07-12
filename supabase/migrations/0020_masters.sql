-- 0020_masters (S1 — doc 11 "employees (+terms✱, hr✱), teams, customers,
-- suppliers, item catalog"; doc 01 L3/L4 shapes). Two-tier sensitivity: the
-- employee row is org-visible; salary/HR data live in side-tables with their
-- own HARD RLS (cost-privilege GUC / owner-admin archetype) — the Najolatech
-- Worker/WorkerLabour/WorkerHr privilege boundaries generalised.
-- Rollback note: forward-only; drop tables (safe pre-data).

-- ── helper: the CURRENT session's role archetype ─────────────────────────────
-- SECURITY DEFINER mirror of the can_access_file_class pattern (0008): lets
-- policies gate on archetype without granting membership/role_definition reads
-- beyond their own policies. Returns null outside a tenant session.
create or replace function app.current_archetype()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select r.archetype
  from public.membership m
  join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
  where m.org_id = app.current_org_id()
    and m.user_id = app.current_user_id()
    and m.deactivated_at is null
$$;
revoke all on function app.current_archetype() from public;
grant execute on function app.current_archetype() to app_user;

-- ── team (before employee — employee references it) ─────────────────────────
create table public.team (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name text not null check (length(name) between 1 and 80),
  kind text not null default 'trade' check (kind in ('trade', 'line')),
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index team_org_idx on public.team (org_id, sort);
alter table public.team enable row level security;
create policy team_select on public.team
  for select to app_user using (org_id = (select app.current_org_id()));
create policy team_insert on public.team
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy team_update on public.team
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.team to app_user;
grant update (name, kind, sort, active, updated_at) on public.team to app_user;
-- No DELETE grant — deactivate instead (D-1.7).

-- ── employee ─────────────────────────────────────────────────────────────────
create table public.employee (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name text not null check (length(name) between 1 and 120),
  user_id uuid references public.user_profile (id), -- optional link to a member
  team_id uuid references public.team (id),
  phone text check (phone is null or length(phone) <= 32),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index employee_org_idx on public.employee (org_id, active, name);
-- A member maps to at most one employee record per org (assigned_job resolver, doc 06 F-6).
create unique index employee_org_user_uq on public.employee (org_id, user_id)
  where user_id is not null;
alter table public.employee enable row level security;
create policy employee_select on public.employee
  for select to app_user using (org_id = (select app.current_org_id()));
create policy employee_insert on public.employee
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy employee_update on public.employee
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.employee to app_user;
grant update (name, user_id, team_id, phone, active, updated_at) on public.employee to app_user;

-- ── employee_terms ✱ (salary — COST-PRIVILEGED wall, D-6.2) ──────────────────
create table public.employee_terms (
  employee_id uuid primary key references public.employee (id) on delete restrict,
  org_id uuid not null references public.org (id) on delete restrict,
  salary_minor bigint not null check (salary_minor >= 0),
  -- default derivation salary/208 happens in the service; stored explicitly.
  hourly_cost_minor bigint not null check (hourly_cost_minor >= 0),
  ot_rate numeric(5, 2) not null default 1.25 check (ot_rate >= 0 and ot_rate <= 10),
  updated_at timestamptz not null default now()
);
create index employee_terms_org_idx on public.employee_terms (org_id);
alter table public.employee_terms enable row level security;
-- The wall is the GUC: only a cost-privileged ctx (withCtx sets app.cost_priv
-- from role_definition.cost_privileged) can read OR write salary data. A
-- foreman/manager session gets zero rows AT THE DATABASE (doc 10 hard wall).
create policy employee_terms_select on public.employee_terms
  for select to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
create policy employee_terms_insert on public.employee_terms
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
create policy employee_terms_update on public.employee_terms
  for update to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()))
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select, insert on public.employee_terms to app_user;
grant update (salary_minor, hourly_cost_minor, ot_rate, updated_at) on public.employee_terms to app_user;

-- ── employee_hr ✱ (identity documents — OWNER/ADMIN wall) ────────────────────
-- Document FILES go to the hr_doc storage class (0008 wall); this table holds
-- the structured expiries that feed E-13 (visa/ID expiry exceptions, S7).
create table public.employee_hr (
  employee_id uuid primary key references public.employee (id) on delete restrict,
  org_id uuid not null references public.org (id) on delete restrict,
  id_number text check (id_number is null or length(id_number) <= 64),
  id_expiry date,
  passport_number text check (passport_number is null or length(passport_number) <= 64),
  passport_expiry date,
  visa_expiry date,
  notes text check (notes is null or length(notes) <= 2000),
  updated_at timestamptz not null default now()
);
create index employee_hr_org_idx on public.employee_hr (org_id);
alter table public.employee_hr enable row level security;
create policy employee_hr_select on public.employee_hr
  for select to app_user
  using (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin')
  );
create policy employee_hr_insert on public.employee_hr
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin')
  );
create policy employee_hr_update on public.employee_hr
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin')
  )
  with check (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin')
  );
grant select, insert on public.employee_hr to app_user;
grant update (id_number, id_expiry, passport_number, passport_expiry, visa_expiry, notes, updated_at)
  on public.employee_hr to app_user;

-- ── customer ─────────────────────────────────────────────────────────────────
create table public.customer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name text not null check (length(name) between 1 and 160),
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  contact_name text check (contact_name is null or length(contact_name) <= 120),
  phone text check (phone is null or length(phone) <= 32),
  email text check (email is null or length(email) <= 254),
  tax_reg_no text check (tax_reg_no is null or length(tax_reg_no) <= 64),
  notes text check (notes is null or length(notes) <= 2000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customer_org_idx on public.customer (org_id, active, name);
alter table public.customer enable row level security;
create policy customer_select on public.customer
  for select to app_user using (org_id = (select app.current_org_id()));
create policy customer_insert on public.customer
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy customer_update on public.customer
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.customer to app_user;
grant update (name, country, contact_name, phone, email, tax_reg_no, notes, active, updated_at)
  on public.customer to app_user;

-- ── supplier ─────────────────────────────────────────────────────────────────
create table public.supplier (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name text not null check (length(name) between 1 and 160),
  tax_reg_no text check (tax_reg_no is null or length(tax_reg_no) <= 64),
  terms_text text check (terms_text is null or length(terms_text) <= 500),
  phone text check (phone is null or length(phone) <= 32),
  email text check (email is null or length(email) <= 254),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index supplier_org_idx on public.supplier (org_id, active, name);
alter table public.supplier enable row level security;
create policy supplier_select on public.supplier
  for select to app_user using (org_id = (select app.current_org_id()));
create policy supplier_insert on public.supplier
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy supplier_update on public.supplier
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.supplier to app_user;
grant update (name, tax_reg_no, terms_text, phone, email, active, updated_at)
  on public.supplier to app_user;

-- ── item (catalog live, stock deferred — doc 01 L3) ──────────────────────────
create table public.item (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  sku text not null check (length(sku) between 1 and 64),
  name text not null check (length(name) between 1 and 160),
  category_key text not null check (category_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  unit text not null check (length(unit) between 1 and 16),
  -- Costs/prices REDACTED server-side by ctx.costPrivileged / pricePrivileged
  -- at every serialization boundary (F-23) — list price data, not the D-6.2
  -- labour wall, so the column-level wall is the serializer, not RLS.
  unit_cost_minor bigint check (unit_cost_minor is null or unit_cost_minor >= 0),
  selling_price_minor bigint check (selling_price_minor is null or selling_price_minor >= 0),
  min_qty numeric(12, 3) check (min_qty is null or min_qty >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index item_org_sku_uq on public.item (org_id, sku);
create index item_org_idx on public.item (org_id, active, category_key, name);
alter table public.item enable row level security;
create policy item_select on public.item
  for select to app_user using (org_id = (select app.current_org_id()));
create policy item_insert on public.item
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy item_update on public.item
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.item to app_user;
grant update (sku, name, category_key, unit, unit_cost_minor, selling_price_minor, min_qty, active, updated_at)
  on public.item to app_user;
