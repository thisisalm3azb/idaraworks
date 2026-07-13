-- 0032_s3_line_soft_delete (S3 fix — D-1.7 "void/supersede, never hard-delete").
-- 0028/0029 granted app_user DELETE on the report line tables to replace lines on
-- a returned-report re-edit. That violates the platform-wide invariant (the
-- tenancy harness: app_user holds NO DELETE grant on ANY public table — archive/
-- void only, the Najolatech rule). Convert line replacement to a SOFT delete via
-- superseded_at, matching job_crew.removed_at (0025). Forward-only.

-- ── drop the DELETE grants + policies (the invariant breach) ─────────────────
revoke delete on public.report_work_line from app_user;
revoke delete on public.report_material_line from app_user;
revoke delete on public.report_labour_line from app_user;
drop policy if exists report_work_line_delete on public.report_work_line;
drop policy if exists report_material_line_delete on public.report_material_line;
drop policy if exists report_labour_line_delete on public.report_labour_line;

-- ── soft-delete column + grant (superseding is an UPDATE, gated by 0031) ──────
alter table public.report_work_line add column if not exists superseded_at timestamptz;
alter table public.report_material_line add column if not exists superseded_at timestamptz;
alter table public.report_labour_line add column if not exists superseded_at timestamptz;
grant update (superseded_at) on public.report_work_line to app_user;
grant update (superseded_at) on public.report_material_line to app_user;
grant update (superseded_at) on public.report_labour_line to app_user;

-- Labour's (report, employee) uniqueness must now ignore superseded rows, so a
-- re-edit can re-add the same employee (old row superseded, new row active).
alter table public.report_labour_line drop constraint if exists report_labour_line_report_emp_uq;
create unique index report_labour_line_active_emp_uq
  on public.report_labour_line (report_id, employee_id)
  where superseded_at is null;

-- ── freeze/derive read only ACTIVE (non-superseded) labour lines ─────────────
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
  if v_org is distinct from app.current_org_id() then
    raise exception 'freeze_report_labour_costs: cross-org freeze blocked';
  end if;

  delete from public.report_labour_cost c
  where c.report_id = p_report_id
    and not exists (
      select 1 from public.report_labour_line l
      where l.report_id = p_report_id and l.employee_id = c.employee_id
        and l.superseded_at is null
    );

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
  where l.report_id = p_report_id and l.org_id = v_org and l.superseded_at is null
  on conflict (report_id, employee_id) do update
    set hourly_cost_minor = excluded.hourly_cost_minor,
        ot_rate = excluded.ot_rate,
        labour_cost_minor = excluded.labour_cost_minor,
        frozen_at = excluded.frozen_at;
end;
$$;

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
  where l.report_id = p_report_id and l.org_id = v_org and l.superseded_at is null
    and (l.normal_hours > 0 or l.ot_hours > 0)
  on conflict (org_id, employee_id, attendance_date) do nothing;
end;
$$;
