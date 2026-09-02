-- H27D — forecasting history, scenarios and targets (ADR-38, ADR-39, ADR-45).
-- A forecast snapshot freezes what the numbers said on a date so management
-- can compare prediction with outcome; a scenario is a saved non-destructive
-- overlay; a target is a dated row (changes append new rows).

create table public.crm_forecast_snapshot (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  -- The period the snapshot describes (month 'YYYY-MM' or quarter 'YYYY-Qn').
  period_key text not null check (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$'),
  scope_kind text not null default 'org' check (scope_kind in ('org', 'team', 'user', 'pipeline')),
  scope_id uuid,
  captured_at timestamptz not null default now(),
  captured_by uuid references public.user_profile (id),          -- null = nightly job
  currency char(3) not null,
  -- Totals by category and model, in minor units, plus counts.
  totals jsonb not null,
  -- Per-opportunity rows: [{id, stageKey, category, valueMinor, probability, weightedMinor, closeDate, ownerId}] (bounded).
  rows jsonb not null default '[]'::jsonb,
  row_count integer not null default 0 check (row_count >= 0),
  note text check (note is null or length(note) <= 500),
  created_at timestamptz not null default now(),
  constraint crm_forecast_snapshot_id_org_uq unique (id, org_id)
);
create index crm_forecast_snapshot_idx on public.crm_forecast_snapshot (org_id, period_key, captured_at desc);
alter table public.crm_forecast_snapshot enable row level security;
create policy crm_forecast_snapshot_select on public.crm_forecast_snapshot
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_forecast_snapshot_insert on public.crm_forecast_snapshot
  for insert to app_user with check (org_id = (select app.current_org_id()));
-- Snapshots are immutable history.
grant select, insert on public.crm_forecast_snapshot to app_user;

create table public.crm_scenario (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name text not null check (length(name) between 1 and 120),
  -- Overlay: {slips:[{opportunityId, months}], excludes:[id], probabilities:[{opportunityId, probability}], notes}
  overlay jsonb not null default '{}'::jsonb,
  assumptions text check (assumptions is null or length(assumptions) <= 2000),
  status text not null default 'draft' check (status in ('draft', 'reviewed', 'applied', 'discarded')),
  applied_at timestamptz,
  applied_by uuid references public.user_profile (id),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_scenario_id_org_uq unique (id, org_id),
  constraint crm_scenario_applied_ck check ((status = 'applied') = (applied_at is not null))
);
create index crm_scenario_org_idx on public.crm_scenario (org_id, status, created_at desc);
alter table public.crm_scenario enable row level security;
create policy crm_scenario_select on public.crm_scenario
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_scenario_insert on public.crm_scenario
  for insert to app_user with check (org_id = (select app.current_org_id())
                                     and created_by = (select app.current_user_id()));
create policy crm_scenario_update on public.crm_scenario
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.crm_scenario to app_user;
grant update (name, overlay, assumptions, status, applied_at, applied_by, updated_at) on public.crm_scenario to app_user;
create trigger crm_scenario_touch before update on public.crm_scenario
  for each row execute function app.set_updated_at();

create table public.crm_target (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  scope_kind text not null check (scope_kind in ('org', 'team', 'user', 'territory')),
  scope_id uuid,                                              -- team, user or territory id
  metric text not null check (metric in ('revenue', 'bookings', 'margin', 'activities', 'new_customers')),
  period_start date not null,
  period_end date not null,
  amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  count_target integer check (count_target is null or count_target >= 0),
  currency char(3),
  effective_from date not null default current_date,
  note text check (note is null or length(note) <= 500),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint crm_target_id_org_uq unique (id, org_id),
  constraint crm_target_period_ck check (period_end >= period_start),
  constraint crm_target_scope_ck check ((scope_kind = 'org') = (scope_id is null)),
  constraint crm_target_value_ck check (
    (metric in ('activities', 'new_customers') and count_target is not null and amount_minor is null)
    or (metric in ('revenue', 'bookings', 'margin') and amount_minor is not null and currency is not null))
);
create index crm_target_org_idx on public.crm_target (org_id, metric, scope_kind, scope_id, period_start, effective_from desc);
alter table public.crm_target enable row level security;
create policy crm_target_select on public.crm_target
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_target_insert on public.crm_target
  for insert to app_user with check (org_id = (select app.current_org_id()));
-- Targets are dated rows: a change is a new row with a later effective_from.
grant select, insert on public.crm_target to app_user;
