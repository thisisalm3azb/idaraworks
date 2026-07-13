-- 0025_s2_plan_assign (S2 — doc 11 "Plan & Assign"; doc 01 L2 full shapes).
-- job grows to its full doc-01 shape; job_stage (weight/name SNAPSHOTS — a
-- template edit never rewrites history), task (checklists, never progress
-- math — U7), job_crew (the F-6 assignment source; soft removal — no DELETE).
-- Progress itself is DERIVED (D-1.4), never stored; current_stage_id is the
-- one sanctioned denormalisation, recomputed by stage-transition commands.
-- Rollback note: forward-only; additive ALTERs + new tables (safe pre-data).

-- ── job → full S2 shape ──────────────────────────────────────────────────────
alter table public.job
  add column kind text not null default 'project' check (kind in ('project')),
  add column progress_override numeric(5, 2)
    check (progress_override is null or (progress_override >= 0 and progress_override <= 100)),
  add column progress_override_reason text
    check (progress_override_reason is null or length(progress_override_reason) between 1 and 500),
  add column progress_override_by uuid references public.user_profile (id),
  add column progress_override_at timestamptz,
  add column start_date date,
  add column due_date date,
  add column completed_date date,
  add column selling_price_minor bigint
    check (selling_price_minor is null or selling_price_minor >= 0),
  -- Append-only audited amount+reason overrides, owner-only (F-10). Shape is
  -- app-validated: [{amount_minor, reason, actor_user_id, at}].
  add column price_adjustments jsonb not null default '[]'::jsonb,
  -- Seeded from the preset at creation, per-job editable, Σpct=100 (F-1).
  add column billing_points jsonb not null default '[]'::jsonb,
  add column payment_terms text check (payment_terms is null or length(payment_terms) <= 500),
  -- Custom-field values (doc-09 #6; registry MVP = job, customer — F-13).
  add column custom_values jsonb not null default '{}'::jsonb;

create index job_org_due_idx on public.job (org_id, due_date)
  where archived = false; -- week view / overdue scans

-- Widen the S1 column-scoped UPDATE grant to the new mutable columns.
grant update (kind, progress_override, progress_override_reason, progress_override_by,
              progress_override_at, start_date, due_date, completed_date,
              selling_price_minor, price_adjustments, billing_points, payment_terms,
              custom_values)
  on public.job to app_user;

-- ── job_stage ────────────────────────────────────────────────────────────────
create table public.job_stage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  job_id uuid not null references public.job (id) on delete restrict,
  stage_key text not null check (stage_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name jsonb not null,                  -- {en, ar} SNAPSHOT at job creation
  weight integer not null check (weight >= 0 and weight <= 100), -- SNAPSHOT
  sort integer not null default 0,      -- template order at creation
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'completed', 'skipped')),
  started_at timestamptz,
  completed_at timestamptz,
  -- Foreman "request-complete" slot (doc 06: C (assigned; request-complete));
  -- the P3 QC guard strengthens the completion transition, never changes it.
  completion_requested_by uuid references public.user_profile (id),
  completion_requested_at timestamptz,
  notes text check (notes is null or length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index job_stage_job_key_uq on public.job_stage (job_id, stage_key);
create index job_stage_org_job_idx on public.job_stage (org_id, job_id, sort);
create index job_stage_org_status_idx on public.job_stage (org_id, status)
  where status = 'in_progress'; -- week view current-work scan
alter table public.job_stage enable row level security;
create policy job_stage_select on public.job_stage
  for select to app_user using (org_id = (select app.current_org_id()));
create policy job_stage_insert on public.job_stage
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy job_stage_update on public.job_stage
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.job_stage to app_user;
grant update (status, started_at, completed_at, completion_requested_by,
              completion_requested_at, notes, updated_at)
  on public.job_stage to app_user;
-- stage_key/name/weight/sort are IMMUTABLE snapshots (not in the grant); no DELETE.

-- job.current_stage_id — the sanctioned denormalisation (doc 01), FK added
-- after job_stage exists.
alter table public.job add column current_stage_id uuid references public.job_stage (id);
grant update (current_stage_id) on public.job to app_user;

-- ── task (checklists that inform humans, not the progress math — U7) ─────────
create table public.task (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  job_id uuid not null references public.job (id) on delete restrict,
  stage_id uuid references public.job_stage (id),
  title text not null check (length(title) between 1 and 200),
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'completed', 'cancelled')),
  assignee_employee_id uuid references public.employee (id),
  due_date date,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index task_org_job_idx on public.task (org_id, job_id, status);
create index task_org_due_idx on public.task (org_id, due_date)
  where status in ('pending', 'in_progress'); -- week view
alter table public.task enable row level security;
create policy task_select on public.task
  for select to app_user using (org_id = (select app.current_org_id()));
create policy task_insert on public.task
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and created_by = (select app.current_user_id())
  );
create policy task_update on public.task
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.task to app_user;
grant update (stage_id, title, status, assignee_employee_id, due_date, updated_at)
  on public.task to app_user;
-- No DELETE — tasks are cancelled, not erased (D-1.7).

-- ── job_crew (F-14: plain membership, no date ranges; the F-6 source) ────────
create table public.job_crew (
  org_id uuid not null references public.org (id) on delete restrict,
  job_id uuid not null references public.job (id) on delete restrict,
  employee_id uuid not null references public.employee (id) on delete restrict,
  added_by uuid not null references public.user_profile (id),
  added_at timestamptz not null default now(),
  -- Soft unassignment: history preserved, no DELETE grant needed; the F-6
  -- resolver and week view read removed_at IS NULL only.
  removed_at timestamptz,
  removed_by uuid references public.user_profile (id),
  primary key (job_id, employee_id)
);
create index job_crew_org_employee_idx on public.job_crew (org_id, employee_id)
  where removed_at is null;
create index job_crew_org_job_idx on public.job_crew (org_id, job_id)
  where removed_at is null;
alter table public.job_crew enable row level security;
create policy job_crew_select on public.job_crew
  for select to app_user using (org_id = (select app.current_org_id()));
create policy job_crew_insert on public.job_crew
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and added_by = (select app.current_user_id())
  );
create policy job_crew_update on public.job_crew
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.job_crew to app_user;
grant update (removed_at, removed_by) on public.job_crew to app_user;
