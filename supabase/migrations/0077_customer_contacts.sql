-- 0077_customer_contacts (H19 — Customer 360 / CRM foundation)
--
-- The audit's documented limitation: public.customer carries exactly ONE
-- embedded contact (contact_name / phone / email, 0020_masters.sql:158-160),
-- so multiple contacts per customer are unsupported. This adds the SMALLEST
-- normalized contact model per the H19 Part I contract - nothing more:
-- no addresses, no marketing consent, no party framework. Existing embedded
-- contact fields are PRESERVED and untouched; the presentation layer adapts
-- them as a virtual primary contact when no rows exist here (compatibility
-- adapter in src/modules/masters/service.ts). No data is migrated.
--
-- International by design: one free-form name (no first/last split), phone
-- as free text (existing 0020 convention), email optional - a contact may
-- have only a phone, only an email, or just a name.

create table public.customer_contact (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  customer_id uuid not null,
  name text not null check (length(name) between 1 and 120),
  -- Free-form role label ("Project engineer", "Accounts"), org terminology.
  role_title text check (role_title is null or length(role_title) <= 80),
  email text check (email is null or length(email) <= 254),
  phone text check (phone is null or length(phone) <= 32),
  preferred_method text not null default 'phone'
    check (preferred_method in ('phone', 'email')),
  is_primary boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Org-scoped FK: a contact can never point at another org's customer.
  constraint customer_contact_customer_org_fk
    foreign key (customer_id, org_id) references public.customer (id, org_id)
);

-- At most ONE active primary contact per customer.
create unique index customer_contact_primary_uq
  on public.customer_contact (customer_id)
  where is_primary and active;
create index customer_contact_org_customer_idx
  on public.customer_contact (org_id, customer_id, active);

alter table public.customer_contact enable row level security;
create policy customer_contact_select on public.customer_contact
  for select to app_user using (org_id = (select app.current_org_id()));
create policy customer_contact_insert on public.customer_contact
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy customer_contact_update on public.customer_contact
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));

grant select, insert on public.customer_contact to app_user;
-- No DELETE: contacts deactivate (active=false), history stays.
grant update (name, role_title, email, phone, preferred_method, is_primary,
              active, updated_at)
  on public.customer_contact to app_user;

comment on table public.customer_contact is
  'H19: minimal normalized customer contacts. The legacy embedded contact on public.customer stays authoritative until an org adds rows here.';
