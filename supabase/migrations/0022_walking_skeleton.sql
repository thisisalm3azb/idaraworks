-- 0022_walking_skeleton (S1 — doc 11: "job + daily_report minimal columns
-- (fleshed in S2/S3)"). The thin end-to-end proof (audit F-48): one job created
-- from a preset + one hardcoded-form daily report, live on RLS, in Arabic.
-- S2 adds job_stage/task/job_crew + the full job columns; S3 adds report lines.
-- Rollback note: forward-only; drop tables (safe pre-data).

-- ── job (minimal S1 shape) ────────────────────────────────────────────────────
create table public.job (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null check (length(reference) between 1 and 40), -- hull number
  name text not null check (length(name) between 1 and 160),
  preset_id uuid references public.job_preset (id),
  customer_id uuid references public.customer (id),
  status_key text not null check (status_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- The semantic anchor (v1 §15 discipline): reporting/engine logic reads THIS,
  -- never the org-configurable status_key.
  status_category text not null check (status_category in ('draft', 'active', 'on_hold', 'done', 'cancelled')),
  manager_user_id uuid references public.user_profile (id),
  foreman_user_id uuid references public.user_profile (id),
  created_by uuid not null references public.user_profile (id),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index job_org_reference_uq on public.job (org_id, reference);
create index job_org_idx on public.job (org_id, archived, status_category, created_at);
alter table public.job enable row level security;
-- S1 reads: all active members (doc 06 — every archetype has jobs.view; the
-- foreman assigned-scope narrowing arrives with S2's job_crew; cost/price
-- redaction is serializer-side, F-23).
create policy job_select on public.job
  for select to app_user using (org_id = (select app.current_org_id()));
create policy job_insert on public.job
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy job_update on public.job
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.job to app_user;
grant update (name, preset_id, customer_id, status_key, status_category,
              manager_user_id, foreman_user_id, archived, updated_at)
  on public.job to app_user;
-- reference is NOT updatable (immutable identity, D-9.2) and no DELETE grant.

-- ── daily_report (minimal S1 header — the heartbeat; lines land in S3) ───────
create table public.daily_report (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  job_id uuid not null references public.job (id) on delete restrict,
  report_date date not null,
  summary text not null check (length(summary) between 1 and 2000),
  blockers text check (blockers is null or length(blockers) <= 2000),
  next_steps text check (next_steps is null or length(next_steps) <= 2000),
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  submitted_by uuid not null references public.user_profile (id),
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One report per job per day (doc 01 D-1.5 shape).
create unique index daily_report_job_date_uq on public.daily_report (org_id, job_id, report_date);
create index daily_report_org_idx on public.daily_report (org_id, report_date);
alter table public.daily_report enable row level security;
create policy daily_report_select on public.daily_report
  for select to app_user using (org_id = (select app.current_org_id()));
-- The reporter is the caller (author backstop — the Phase F comment lesson).
create policy daily_report_insert on public.daily_report
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and submitted_by = (select app.current_user_id())
  );
create policy daily_report_update on public.daily_report
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.daily_report to app_user;
grant update (summary, blockers, next_steps, status, submitted_at, updated_at)
  on public.daily_report to app_user;
-- No DELETE grant — reports are the audit heartbeat (D-1.5/D-1.7).
