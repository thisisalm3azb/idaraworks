-- 0030_s3_issues (S3 — "Report: the heartbeat", part 3 of 3).
-- Issues: raise-from-anywhere problem tickets (doc 01 L4; doc 06 row 47). A
-- blocker issue is the field's fast path to a manager. Job link is OPTIONAL — an
-- issue can be org-wide (a broken tool) or job-scoped. Photos attach through the
-- generic files table (entity_type='issue'), so no schema here for them.
-- Forward-only: one additive table.

create table public.issue (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  -- Nullable job link (MATCH SIMPLE composite FK: (null, org) skips the check).
  job_id uuid,
  title text not null check (length(title) between 1 and 200),
  description text check (description is null or length(description) <= 4000),
  severity text not null default 'medium'
    check (severity in ('low', 'medium', 'high', 'critical')),
  is_blocker boolean not null default false,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'resolved', 'closed')),
  raised_by uuid not null references public.user_profile (id),
  assignee_employee_id uuid,
  resolved_by uuid references public.user_profile (id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index issue_org_status_idx on public.issue (org_id, status, is_blocker, created_at);
create index issue_org_job_idx on public.issue (org_id, job_id);
-- Same-org composite FKs (job/employee both nullable, MATCH SIMPLE).
alter table public.issue
  add constraint issue_job_org_fk foreign key (job_id, org_id)
  references public.job (id, org_id) on delete restrict;
alter table public.issue
  add constraint issue_assignee_org_fk foreign key (assignee_employee_id, org_id)
  references public.employee (id, org_id) on delete restrict;
alter table public.issue enable row level security;
create policy issue_select on public.issue
  for select to app_user using (org_id = (select app.current_org_id()));
-- Author backstop (the Phase F comment lesson): the raiser is the caller.
create policy issue_insert on public.issue
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and raised_by = (select app.current_user_id())
  );
create policy issue_update on public.issue
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.issue to app_user;
grant update (
  title, description, severity, is_blocker, status,
  assignee_employee_id, resolved_by, resolved_at, updated_at
) on public.issue to app_user;
-- No DELETE grant — issues are part of the operational record (close, don't delete).
