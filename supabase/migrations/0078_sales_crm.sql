-- 0078_sales_crm (H20 - leads, opportunities, pipeline, sales activities)
--
-- The smallest durable CRM models: a potential sale exists BEFORE a
-- customer, a price or a quotation. Opportunity value is FORECAST value -
-- never invoiced revenue, cash, or receivables (those stay with invoices
-- and payments). Same architecture as every other module: org-scoped rows,
-- composite FKs pinned to (id, org_id) uniques, RLS on org_id, app-side
-- column grants, NO DELETE anywhere (archive/terminal states only).
--
-- Also closes the H19-noted index gaps: job(org_id, customer_id) and
-- customer_update(org_id, customer_id).

-- ── pipeline stages (org-configurable; stable keys, editable labels) ───────
create table public.pipeline_stage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label jsonb not null,                -- {en, ar}; renaming never touches key
  sort integer not null default 0,
  -- Terminal categories are structural: won/lost stages cannot be recategorized
  -- (no category in the UPDATE grant below).
  category text not null default 'open' check (category in ('open', 'won', 'lost')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pipeline_stage_org_key_uq unique (org_id, key),
  constraint pipeline_stage_id_org_uq unique (id, org_id)
);
create index pipeline_stage_org_idx on public.pipeline_stage (org_id, active, sort);
alter table public.pipeline_stage enable row level security;
create policy pipeline_stage_select on public.pipeline_stage
  for select to app_user using (org_id = (select app.current_org_id()));
create policy pipeline_stage_insert on public.pipeline_stage
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy pipeline_stage_update on public.pipeline_stage
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.pipeline_stage to app_user;
grant update (label, sort, active, updated_at) on public.pipeline_stage to app_user;

-- ── leads (pre-customer sales records) ─────────────────────────────────────
create table public.lead (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name text not null check (length(name) between 1 and 160),  -- person OR organization
  contact_name text check (contact_name is null or length(contact_name) <= 120),
  phone text check (phone is null or length(phone) <= 32),
  email text check (email is null or length(email) <= 254),
  source text check (source is null or length(source) <= 80),
  status text not null default 'new'
    check (status in ('new', 'contacted', 'qualified', 'disqualified', 'converted')),
  owner_user_id uuid references public.user_profile (id),
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  notes text check (notes is null or length(notes) <= 2000),
  -- Conversion evidence (the lead is PRESERVED, never overwritten):
  converted_opportunity_id uuid,
  converted_customer_id uuid,
  converted_at timestamptz,
  archived boolean not null default false,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_id_org_uq unique (id, org_id),
  constraint lead_converted_ck
    check (status <> 'converted' or converted_at is not null)
);
create index lead_org_idx on public.lead (org_id, archived, status, created_at desc);
create index lead_org_owner_idx on public.lead (org_id, owner_user_id);
alter table public.lead enable row level security;
create policy lead_select on public.lead
  for select to app_user using (org_id = (select app.current_org_id()));
create policy lead_insert on public.lead
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy lead_update on public.lead
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.lead to app_user;
grant update (name, contact_name, phone, email, source, status, owner_user_id,
              country, notes, converted_opportunity_id, converted_customer_id,
              converted_at, archived, updated_at)
  on public.lead to app_user;

-- ── opportunities (qualified potential sales; forecast value only) ─────────
create table public.opportunity (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name text not null check (length(name) between 1 and 160),
  customer_id uuid,
  lead_id uuid,
  owner_user_id uuid references public.user_profile (id),
  stage_key text not null,
  status text not null default 'open' check (status in ('open', 'won', 'lost')),
  -- FORECAST value in base-currency minor units. Never revenue or cash.
  estimated_value_minor bigint check (estimated_value_minor is null or estimated_value_minor >= 0),
  currency char(3),
  expected_close_date date,
  probability integer check (probability is null or (probability between 0 and 100)),
  next_action text check (next_action is null or length(next_action) <= 300),
  next_action_due date,
  quote_id uuid,
  loss_reason text check (loss_reason is null or
    loss_reason in ('price', 'timing', 'competitor', 'no_budget', 'no_response', 'scope', 'other')),
  loss_note text check (loss_note is null or length(loss_note) <= 1000),
  won_at timestamptz,
  lost_at timestamptz,
  archived boolean not null default false,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunity_id_org_uq unique (id, org_id),
  constraint opportunity_customer_org_fk
    foreign key (customer_id, org_id) references public.customer (id, org_id),
  constraint opportunity_lead_org_fk
    foreign key (lead_id, org_id) references public.lead (id, org_id),
  constraint opportunity_stage_org_fk
    foreign key (org_id, stage_key) references public.pipeline_stage (org_id, key),
  constraint opportunity_quote_org_fk
    foreign key (quote_id, org_id) references public.quote (id, org_id),
  constraint opportunity_won_ck check (status <> 'won' or won_at is not null),
  constraint opportunity_lost_ck
    check (status <> 'lost' or (lost_at is not null and loss_reason is not null))
);
create index opportunity_org_stage_idx
  on public.opportunity (org_id, status, stage_key, archived);
create index opportunity_org_owner_idx on public.opportunity (org_id, owner_user_id);
create index opportunity_org_customer_idx on public.opportunity (org_id, customer_id);
create index opportunity_org_lead_idx on public.opportunity (org_id, lead_id);
create index opportunity_org_close_idx
  on public.opportunity (org_id, expected_close_date)
  where status = 'open' and archived = false;
alter table public.opportunity enable row level security;
create policy opportunity_select on public.opportunity
  for select to app_user using (org_id = (select app.current_org_id()));
create policy opportunity_insert on public.opportunity
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy opportunity_update on public.opportunity
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.opportunity to app_user;
grant update (name, customer_id, owner_user_id, stage_key, status,
              estimated_value_minor, currency, expected_close_date, probability,
              next_action, next_action_due, quote_id, loss_reason, loss_note,
              won_at, lost_at, archived, updated_at)
  on public.opportunity to app_user;

-- ── sales activities (notes, calls, meetings, follow-ups, lifecycle marks) ─
create table public.sales_activity (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  lead_id uuid,
  opportunity_id uuid,
  kind text not null check (kind in
    ('note', 'call', 'meeting', 'email', 'follow_up', 'stage_change',
     'quote_created', 'won', 'lost')),
  body text check (body is null or length(body) <= 2000),
  due_date date,
  completed_at timestamptz,
  owner_user_id uuid references public.user_profile (id), -- responsible (follow-ups)
  actor_user_id uuid references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint sales_activity_lead_org_fk
    foreign key (lead_id, org_id) references public.lead (id, org_id),
  constraint sales_activity_opp_org_fk
    foreign key (opportunity_id, org_id) references public.opportunity (id, org_id),
  constraint sales_activity_subject_ck
    check (lead_id is not null or opportunity_id is not null),
  constraint sales_activity_followup_ck
    check (kind <> 'follow_up' or due_date is not null)
);
create index sales_activity_org_opp_idx
  on public.sales_activity (org_id, opportunity_id, created_at desc);
create index sales_activity_org_lead_idx
  on public.sales_activity (org_id, lead_id, created_at desc);
create index sales_activity_followup_due_idx
  on public.sales_activity (org_id, due_date)
  where kind = 'follow_up' and completed_at is null;
alter table public.sales_activity enable row level security;
create policy sales_activity_select on public.sales_activity
  for select to app_user using (org_id = (select app.current_org_id()));
create policy sales_activity_insert on public.sales_activity
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy sales_activity_update on public.sales_activity
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.sales_activity to app_user;
-- Only follow-up completion is mutable; history rows never change.
grant update (completed_at, owner_user_id, due_date) on public.sales_activity to app_user;

-- ── H19-noted index gaps (audit-confirmed absent) ──────────────────────────
create index if not exists job_org_customer_idx on public.job (org_id, customer_id);
create index if not exists customer_update_org_customer_idx
  on public.customer_update (org_id, customer_id);

comment on table public.lead is
  'H20: pre-customer sales records. Conversion preserves the lead and records evidence; no deletes.';
comment on table public.opportunity is
  'H20: qualified potential sales. estimated_value_minor is FORECAST value, never revenue.';
