-- H27E — customer success signals, reviewed customer merges, and governed
-- automation with an idempotent execution history (ADR-42, ADR-43, ADR-44).

-- ── satisfaction, onboarding and success records (evidence for health) ─────
create table public.crm_customer_signal (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  customer_id uuid not null,
  kind text not null check (kind in ('satisfaction', 'onboarding', 'adoption', 'success_plan', 'churn_risk', 'note')),
  -- satisfaction: 1..5; onboarding: 0..100 percent; adoption: 0..100; churn_risk: 0..100
  score integer check (score is null or score between 0 and 100),
  status text check (status is null or status in ('open', 'done', 'at_risk', 'healthy')),
  title text check (title is null or length(title) <= 200),
  body text check (body is null or length(body) <= 4000),
  due_on date,
  recorded_at timestamptz not null default now(),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_customer_signal_id_org_uq unique (id, org_id),
  constraint crm_customer_signal_customer_fk foreign key (customer_id, org_id)
    references public.customer (id, org_id) on delete restrict,
  constraint crm_customer_signal_score_ck check (kind <> 'satisfaction' or (score is not null and score between 1 and 5))
);
create index crm_customer_signal_idx on public.crm_customer_signal (org_id, customer_id, kind, recorded_at desc);
alter table public.crm_customer_signal enable row level security;
create policy crm_customer_signal_select on public.crm_customer_signal
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_customer_signal_insert on public.crm_customer_signal
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy crm_customer_signal_update on public.crm_customer_signal
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.crm_customer_signal to app_user;
grant update (status, title, body, due_on, updated_at) on public.crm_customer_signal to app_user;
create trigger crm_customer_signal_touch before update on public.crm_customer_signal
  for each row execute function app.set_updated_at();

-- ── reviewed customer merge with immutable evidence ─────────────────────────
create table public.crm_merge (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  source_customer_id uuid not null,
  target_customer_id uuid not null,
  -- The preview the person approved: field resolutions and counts per table.
  preview jsonb not null,
  resolutions jsonb not null default '{}'::jsonb,
  -- Full row images before the merge (source and target), for reversal by a person.
  source_snapshot jsonb not null,
  target_snapshot jsonb not null,
  -- Counts of rows re-pointed per table, as applied.
  repointed jsonb not null default '{}'::jsonb,
  reason text not null check (length(reason) between 1 and 1000),
  applied_at timestamptz not null default now(),
  applied_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint crm_merge_id_org_uq unique (id, org_id),
  constraint crm_merge_source_fk foreign key (source_customer_id, org_id)
    references public.customer (id, org_id) on delete restrict,
  constraint crm_merge_target_fk foreign key (target_customer_id, org_id)
    references public.customer (id, org_id) on delete restrict,
  constraint crm_merge_distinct_ck check (source_customer_id <> target_customer_id)
);
create index crm_merge_org_idx on public.crm_merge (org_id, applied_at desc);
alter table public.crm_merge enable row level security;
create policy crm_merge_select on public.crm_merge
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_merge_insert on public.crm_merge
  for insert to app_user with check (org_id = (select app.current_org_id())
                                     and applied_by = (select app.current_user_id()));
-- Merge evidence is immutable.
grant select, insert on public.crm_merge to app_user;

-- ── governed automation ─────────────────────────────────────────────────────
create table public.crm_automation (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name text not null check (length(name) between 1 and 120),
  description text check (description is null or length(description) <= 1000),
  trigger text not null check (trigger in (
    'lead_created', 'lead_unassigned', 'lead_stale',
    'opportunity_stage_aged', 'opportunity_stalled', 'opportunity_close_date_passed',
    'opportunity_stage_entered', 'renewal_due', 'customer_at_risk', 'follow_up_overdue')),
  -- platform/rules conditions over the subject's facts (evaluated in app code).
  conditions jsonb not null default '{"all":[]}'::jsonb,
  -- Closed action list: [{kind:'assign_owner'|'create_task'|'notify'|'request_approval'|'flag_risk'|'set_forecast_category', ...}]
  actions jsonb not null default '[]'::jsonb,
  enabled boolean not null default false,
  dry_run boolean not null default true,
  owner_user_id uuid not null references public.user_profile (id),
  last_run_at timestamptz,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_automation_id_org_uq unique (id, org_id)
);
create index crm_automation_org_idx on public.crm_automation (org_id, enabled, trigger);
alter table public.crm_automation enable row level security;
create policy crm_automation_select on public.crm_automation
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_automation_insert on public.crm_automation
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy crm_automation_update on public.crm_automation
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.crm_automation to app_user;
grant update (name, description, trigger, conditions, actions, enabled, dry_run, owner_user_id,
              last_run_at, updated_at)
  on public.crm_automation to app_user;
create trigger crm_automation_touch before update on public.crm_automation
  for each row execute function app.set_updated_at();

create table public.crm_automation_run (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  automation_id uuid not null,
  -- Idempotency: one execution per automation × subject × occurrence key.
  subject_type text not null check (subject_type in ('lead', 'opportunity', 'customer', 'activity', 'obligation')),
  subject_id uuid not null,
  occurrence_key text not null check (length(occurrence_key) between 1 and 120),
  mode text not null check (mode in ('dry_run', 'live')),
  status text not null check (status in ('matched', 'skipped', 'applied', 'failed')),
  -- What would happen / happened, per action, with errors.
  result jsonb not null default '[]'::jsonb,
  error text check (error is null or length(error) <= 1000),
  ran_at timestamptz not null default now(),
  ran_by uuid references public.user_profile (id),                -- null = worker
  constraint crm_automation_run_id_org_uq unique (id, org_id),
  constraint crm_automation_run_automation_fk foreign key (automation_id, org_id)
    references public.crm_automation (id, org_id) on delete restrict,
  constraint crm_automation_run_once_uq unique (automation_id, subject_type, subject_id, occurrence_key, mode)
);
create index crm_automation_run_idx on public.crm_automation_run (org_id, automation_id, ran_at desc);
alter table public.crm_automation_run enable row level security;
create policy crm_automation_run_select on public.crm_automation_run
  for select to app_user using (org_id = (select app.current_org_id()));
create policy crm_automation_run_insert on public.crm_automation_run
  for insert to app_user with check (org_id = (select app.current_org_id()));
-- Execution history is immutable.
grant select, insert on public.crm_automation_run to app_user;
