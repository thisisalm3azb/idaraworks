-- 0029_s3_labour_attendance (S3 — "Report: the heartbeat", part 2 of 3).
-- The D-6.2 cost wall, applied to daily-report labour: a foreman ENTERS hours
-- (non-privileged) but the frozen COST snapshot lives in a side-table only a
-- cost-privileged session can read — the exact employee/employee_terms split
-- (0020), reused for report labour. Attendance derives from those hours (U3/C-3:
-- "labour lines are the write") plus a manager's manual grid.
-- Forward-only: additive tables + SECURITY DEFINER helpers.

-- ── report_labour_line (HOURS — non-privileged, foreman-writable) ────────────
create table public.report_labour_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  report_id uuid not null references public.daily_report (id) on delete restrict,
  employee_id uuid not null references public.employee (id) on delete restrict,
  normal_hours numeric(6, 2) not null default 0 check (normal_hours >= 0 and normal_hours <= 24),
  ot_hours numeric(6, 2) not null default 0 check (ot_hours >= 0 and ot_hours <= 24),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  constraint report_labour_line_report_emp_uq unique (report_id, employee_id)
);
create index report_labour_line_report_idx on public.report_labour_line (org_id, report_id, sort);
alter table public.report_labour_line
  add constraint report_labour_line_report_org_fk foreign key (report_id, org_id)
  references public.daily_report (id, org_id) on delete restrict;
alter table public.report_labour_line
  add constraint report_labour_line_emp_org_fk foreign key (employee_id, org_id)
  references public.employee (id, org_id) on delete restrict;
alter table public.report_labour_line enable row level security;
create policy report_labour_line_select on public.report_labour_line
  for select to app_user using (org_id = (select app.current_org_id()));
create policy report_labour_line_insert on public.report_labour_line
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy report_labour_line_update on public.report_labour_line
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
-- Same parent-status DELETE gate as the other lines (draft/returned only).
create policy report_labour_line_delete on public.report_labour_line
  for delete to app_user
  using (
    org_id = (select app.current_org_id())
    and exists (
      select 1 from public.daily_report r
      where r.id = report_id and r.org_id = (select app.current_org_id())
        and r.status in ('draft', 'returned')
    )
  );
grant select, insert, delete on public.report_labour_line to app_user;
grant update (normal_hours, ot_hours, sort) on public.report_labour_line to app_user;

-- ── report_labour_cost ✱ (FROZEN cost snapshot — COST-PRIVILEGED wall) ───────
-- The rate is snapshotted AT SUBMIT (D-1.4): a later salary change never rewrites
-- a historical report's cost. RLS is the wall — a foreman/manager session reads
-- ZERO rows at the database, exactly like employee_terms (0020).
create table public.report_labour_cost (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  report_id uuid not null references public.daily_report (id) on delete restrict,
  employee_id uuid not null references public.employee (id) on delete restrict,
  hourly_cost_minor bigint not null check (hourly_cost_minor >= 0),
  ot_rate numeric(5, 2) not null check (ot_rate >= 0 and ot_rate <= 10),
  labour_cost_minor bigint not null check (labour_cost_minor >= 0),
  frozen_at timestamptz not null default now(),
  constraint report_labour_cost_report_emp_uq unique (report_id, employee_id)
);
create index report_labour_cost_report_idx on public.report_labour_cost (org_id, report_id);
alter table public.report_labour_cost
  add constraint report_labour_cost_report_org_fk foreign key (report_id, org_id)
  references public.daily_report (id, org_id) on delete restrict;
alter table public.report_labour_cost
  add constraint report_labour_cost_emp_org_fk foreign key (employee_id, org_id)
  references public.employee (id, org_id) on delete restrict;
alter table public.report_labour_cost enable row level security;
create policy report_labour_cost_select on public.report_labour_cost
  for select to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
create policy report_labour_cost_insert on public.report_labour_cost
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
create policy report_labour_cost_update on public.report_labour_cost
  for update to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()))
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select, insert, update on public.report_labour_cost to app_user;
-- No app_user DELETE — re-freeze (below) is a SECURITY DEFINER owner operation.

-- ── app.freeze_report_labour_costs (SECURITY DEFINER — crosses the cost wall) ─
-- Called inside the submit/edit command. It reads employee_terms (the cost wall)
-- with DEFINER rights, so a NON-cost-privileged foreman's submit freezes cost
-- WITHOUT the foreman ever reading it — the RLS select wall above stays intact.
-- Idempotent: re-freezes on returned→resubmit and prunes rows for employees no
-- longer on the report. Org-guarded against cross-tenant misuse.
create or replace function app.freeze_report_labour_costs(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.daily_report where id = p_report_id;
  if v_org is null then
    raise exception 'freeze_report_labour_costs: report % not found', p_report_id;
  end if;
  -- Defence-in-depth: the caller may only freeze their OWN org's report.
  if v_org is distinct from app.current_org_id() then
    raise exception 'freeze_report_labour_costs: cross-org freeze blocked';
  end if;

  -- Prune cost rows whose employee is no longer on the report (re-edit shrank it).
  delete from public.report_labour_cost c
  where c.report_id = p_report_id
    and not exists (
      select 1 from public.report_labour_line l
      where l.report_id = p_report_id and l.employee_id = c.employee_id
    );

  -- Freeze/refresh cost for every labour line that has configured terms. Lines
  -- for employees WITHOUT terms simply get no cost row (cost genuinely unknown).
  insert into public.report_labour_cost
    (id, org_id, report_id, employee_id, hourly_cost_minor, ot_rate, labour_cost_minor, frozen_at)
  select
    gen_random_uuid(), v_org, p_report_id, l.employee_id,
    t.hourly_cost_minor, t.ot_rate,
    round(l.normal_hours * t.hourly_cost_minor
          + l.ot_hours * t.hourly_cost_minor * t.ot_rate)::bigint,
    now()
  from public.report_labour_line l
  join public.employee_terms t
    on t.employee_id = l.employee_id and t.org_id = v_org
  where l.report_id = p_report_id and l.org_id = v_org
  on conflict (report_id, employee_id) do update
    set hourly_cost_minor = excluded.hourly_cost_minor,
        ot_rate = excluded.ot_rate,
        labour_cost_minor = excluded.labour_cost_minor,
        frozen_at = excluded.frozen_at;
end;
$$;
revoke all on function app.freeze_report_labour_costs(uuid) from public;
grant execute on function app.freeze_report_labour_costs(uuid) to app_user;

-- ── attendance (present/absent grid — derived from labour + manual override) ─
create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null references public.employee (id) on delete restrict,
  attendance_date date not null,
  status text not null
    check (status in ('present', 'absent', 'leave', 'half_day', 'sick', 'late')),
  source text not null default 'manual' check (source in ('labour_line', 'manual')),
  marked_by uuid references public.user_profile (id),
  note text check (note is null or length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_emp_date_uq unique (org_id, employee_id, attendance_date)
);
create index attendance_org_date_idx on public.attendance (org_id, attendance_date);
alter table public.attendance
  add constraint attendance_emp_org_fk foreign key (employee_id, org_id)
  references public.employee (id, org_id) on delete restrict;
alter table public.attendance enable row level security;
-- Read: org-scoped (the archetype gate — viewer/accounts V, foreman none — is the
-- service assertCan('attendance.view'); attendance is not a hard PII wall, doc 06
-- grants viewer V). Manual writes are manager+ AT THE DATABASE; the labour-line
-- derivation is a DEFINER write (below), so a foreman never needs attendance grant.
create policy attendance_select on public.attendance
  for select to app_user using (org_id = (select app.current_org_id()));
create policy attendance_insert on public.attendance
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin', 'manager')
  );
create policy attendance_update on public.attendance
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin', 'manager')
  )
  with check (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin', 'manager')
  );
grant select, insert on public.attendance to app_user;
grant update (status, source, marked_by, note, updated_at) on public.attendance to app_user;

-- ── app.derive_attendance_from_report (SECURITY DEFINER — the C-3 write) ──────
-- On submit, each employee with hours is marked present for the report date.
-- MANUAL entries win: on conflict do NOTHING, so a manager's grid correction is
-- never clobbered by a (re)submit. Definer rights let a foreman's submit create
-- attendance without the manager-only insert grant above.
create or replace function app.derive_attendance_from_report(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_date date;
begin
  select org_id, report_date into v_org, v_date
  from public.daily_report where id = p_report_id;
  if v_org is null then
    raise exception 'derive_attendance_from_report: report % not found', p_report_id;
  end if;
  if v_org is distinct from app.current_org_id() then
    raise exception 'derive_attendance_from_report: cross-org derive blocked';
  end if;

  insert into public.attendance
    (id, org_id, employee_id, attendance_date, status, source, marked_by)
  select
    gen_random_uuid(), v_org, l.employee_id, v_date, 'present', 'labour_line',
    app.current_user_id()
  from public.report_labour_line l
  where l.report_id = p_report_id and l.org_id = v_org
    and (l.normal_hours > 0 or l.ot_hours > 0)
  on conflict (org_id, employee_id, attendance_date) do nothing;
end;
$$;
revoke all on function app.derive_attendance_from_report(uuid) from public;
grant execute on function app.derive_attendance_from_report(uuid) to app_user;
