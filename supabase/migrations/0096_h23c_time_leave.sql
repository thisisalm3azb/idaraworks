-- ═════════════════════════════════════════════════════════════════════════════
-- H23C — schedules, punches, corrections, overtime and leave.
--
-- EXTENDS the S3 attendance system. The `attendance` table stays the canonical
-- one-row-per-employee-per-day record; punches arrive as an append-only event
-- stream that a SECURITY DEFINER rollup materializes into that same row, and
-- approved leave RESOLVES into it (a new source value) rather than living in a
-- parallel calendar. Nothing here waits on a worker: rollups happen at write
-- time, reminders are computed on read.
-- ═════════════════════════════════════════════════════════════════════════════

-- Overlap prevention for leave needs range exclusion over equality columns.
-- Into the extensions schema, NEVER public: the extension ships C functions
-- executable by PUBLIC, and the 0016 sweep (rightly) forbids that in public.
-- Default gist opclasses are catalog-wide, so the exclusion constraints below
-- resolve regardless of schema.
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- ── work patterns and shifts ─────────────────────────────────────────────────
-- A pattern is the WEEK template (which days, how many hours). A shift is a
-- clock template (start/end/break). Assignment picks one per employee/team,
-- most-specific wins; the org default pattern backs everything.
create table public.work_pattern (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name_en text not null check (length(trim(name_en)) between 1 and 120),
  name_ar text check (name_ar is null or length(name_ar) <= 120),
  /*
   * days: {"mon": {"start":"08:00","end":"17:00","break_minutes":60}, ... }
   * A missing key or null value = a non-working day. Validated by the service
   * (zod); the DB requires only that it is an object.
   */
  days jsonb not null default '{}'::jsonb check (jsonb_typeof(days) = 'object'),
  weekly_hours numeric(5, 2) not null default 48 check (weekly_hours between 0 and 168),
  is_default boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_pattern_id_org_uq unique (id, org_id)
);
create unique index work_pattern_default_uq on public.work_pattern (org_id) where is_default;
alter table public.work_pattern enable row level security;
create policy work_pattern_all on public.work_pattern
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.work_pattern to app_user;
grant update (name_en, name_ar, days, weekly_hours, is_default, active, updated_at)
  on public.work_pattern to app_user;

create table public.shift (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name_en text not null check (length(trim(name_en)) between 1 and 120),
  name_ar text check (name_ar is null or length(name_ar) <= 120),
  starts_at time not null,
  ends_at time not null,
  break_minutes integer not null default 0 check (break_minutes between 0 and 480),
  -- ends_at <= starts_at means the shift crosses midnight (overnight).
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_id_org_uq unique (id, org_id)
);
alter table public.shift enable row level security;
create policy shift_all on public.shift
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.shift to app_user;
grant update (name_en, name_ar, starts_at, ends_at, break_minutes, active, updated_at)
  on public.shift to app_user;

-- One target per row: employee, team or location (exactly one), so precedence
-- is legible: employee beats team beats location beats the default pattern.
create table public.schedule_assignment (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid,
  team_id uuid references public.team (id),
  work_location_id uuid,
  pattern_id uuid,
  shift_id uuid,
  starts_on date not null,
  ends_on date,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint schedule_assignment_id_org_uq unique (id, org_id),
  constraint schedule_assignment_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint schedule_assignment_location_fk foreign key (work_location_id, org_id)
    references public.work_location (id, org_id) on delete restrict,
  constraint schedule_assignment_pattern_fk foreign key (pattern_id, org_id)
    references public.work_pattern (id, org_id) on delete restrict,
  constraint schedule_assignment_shift_fk foreign key (shift_id, org_id)
    references public.shift (id, org_id) on delete restrict,
  constraint schedule_assignment_one_target_ck check (
    (case when employee_id is not null then 1 else 0 end
     + case when team_id is not null then 1 else 0 end
     + case when work_location_id is not null then 1 else 0 end) = 1),
  constraint schedule_assignment_content_ck check (pattern_id is not null or shift_id is not null),
  constraint schedule_assignment_span_ck check (ends_on is null or ends_on >= starts_on)
);
create index schedule_assignment_org_idx on public.schedule_assignment (org_id, starts_on);
alter table public.schedule_assignment enable row level security;
create policy schedule_assignment_all on public.schedule_assignment
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.schedule_assignment to app_user;
grant update (ends_on) on public.schedule_assignment to app_user;

-- ── punches: the append-only clock stream ────────────────────────────────────
create table public.attendance_event (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  kind text not null check (kind in ('in', 'out', 'break_start', 'break_end')),
  at timestamptz not null default now(),
  -- The org-timezone DATE this punch belongs to, stamped at write so overnight
  -- shifts land on the day the shift STARTED, not the calendar midnight.
  work_date date not null,
  source text not null default 'self' check (source in ('self', 'manager', 'correction')),
  recorded_by uuid not null references public.user_profile (id),
  note text check (note is null or length(note) <= 300),
  -- A correction points at what it corrects; the original stays visible.
  corrects_id uuid,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint attendance_event_id_org_uq unique (id, org_id),
  constraint attendance_event_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint attendance_event_corrects_fk foreign key (corrects_id, org_id)
    references public.attendance_event (id, org_id) on delete restrict
);
create index attendance_event_org_emp_date_idx
  on public.attendance_event (org_id, employee_id, work_date);
alter table public.attendance_event enable row level security;
-- Everyone may read their own punches; managers read the org.
create policy attendance_event_select on public.attendance_event
  for select to app_user
  using (org_id = (select app.current_org_id())
         and ((select app.current_archetype()) in ('owner', 'admin', 'manager', 'accounts', 'viewer')
              or employee_id = (select app.current_employee_id())));
-- Self-punch: any member may insert 'self' events FOR THEIR OWN employee row;
-- managers insert for anyone.
create policy attendance_event_insert on public.attendance_event
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and (((source = 'self') and employee_id = (select app.current_employee_id()))
                   or (select app.current_archetype()) in ('owner', 'admin', 'manager')));
-- Void only (for corrections); the row itself never changes otherwise.
create policy attendance_event_update on public.attendance_event
  for update to app_user
  using (org_id = (select app.current_org_id())
         and (select app.current_archetype()) in ('owner', 'admin', 'manager'))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.attendance_event to app_user;
grant update (voided_at) on public.attendance_event to app_user;

-- ── the day row learns clock arithmetic ──────────────────────────────────────
alter table public.attendance
  add column check_in timestamptz,
  add column check_out timestamptz,
  add column worked_minutes integer check (worked_minutes is null or worked_minutes >= 0),
  add column break_minutes integer check (break_minutes is null or break_minutes >= 0),
  add column late_minutes integer check (late_minutes is null or late_minutes >= 0),
  add column early_leave_minutes integer
    check (early_leave_minutes is null or early_leave_minutes >= 0),
  add column missing_punch boolean not null default false;

-- Leave resolution and punch rollups become legal sources.
alter table public.attendance drop constraint attendance_source_check;
alter table public.attendance
  add constraint attendance_source_check
  check (source in ('labour_line', 'manual', 'clock', 'leave_request'));

-- The clock columns must be writable through the manager grant, or the
-- correction upsert dies on permission at the database.
grant update (check_in, check_out, worked_minutes, break_minutes,
              late_minutes, early_leave_minutes, missing_punch)
  on public.attendance to app_user;

-- Employees may see their own day rows (self-service); the org-wide read
-- policy from 0029 already covers managers/accounts/viewer.
create policy attendance_select_self on public.attendance
  for select to app_user
  using (org_id = (select app.current_org_id())
         and employee_id = (select app.current_employee_id()));

/*
 * Materialize one day from its punches. SECURITY DEFINER so a self-punching
 * member (who has no attendance write grant) still updates the day row.
 *
 * Pairing rule: first non-void 'in' opens the day, last non-void 'out' closes
 * it; break pairs subtract. Lateness/early-leave are computed against the
 * scheduled shift when one applies — a day with no schedule has no lateness.
 * MANUAL statuses win: a manager's explicit mark is never overwritten (the
 * 0029 rule, kept), but clock numbers still attach to the row.
 */
create or replace function app.rollup_attendance_day(
  p_org uuid, p_employee uuid, p_date date
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_in timestamptz;
  v_out timestamptz;
  v_break integer := 0;
  v_worked integer;
  v_late integer := 0;
  v_early integer := 0;
  v_missing boolean := false;
  v_shift record;
  v_status text;
  v_existing_source text;
begin
  select min(at) filter (where kind = 'in'),
         max(at) filter (where kind = 'out')
    into v_in, v_out
  from public.attendance_event
  where org_id = p_org and employee_id = p_employee and work_date = p_date
    and voided_at is null;

  select coalesce(sum(extract(epoch from (be.at - bs.at)) / 60), 0)::int into v_break
  from public.attendance_event bs
  join lateral (
    select at from public.attendance_event e2
    where e2.org_id = bs.org_id and e2.employee_id = bs.employee_id
      and e2.work_date = bs.work_date and e2.kind = 'break_end'
      and e2.voided_at is null and e2.at > bs.at
    order by e2.at limit 1
  ) be on true
  where bs.org_id = p_org and bs.employee_id = p_employee
    and bs.work_date = p_date and bs.kind = 'break_start' and bs.voided_at is null;

  if v_in is null and v_out is null then
    return; -- nothing to materialize
  end if;
  v_missing := (v_in is null) or (v_out is null);
  if v_in is not null and v_out is not null and v_out > v_in then
    v_worked := greatest(0, (extract(epoch from (v_out - v_in)) / 60)::int - v_break);
  end if;

  -- The applicable shift, most-specific first: employee, then team, then location.
  select s.starts_at, s.ends_at into v_shift
  from public.schedule_assignment a
  join public.shift s on s.id = a.shift_id and s.org_id = a.org_id
  left join public.employee e on e.id = p_employee and e.org_id = p_org
  where a.org_id = p_org
    and a.starts_on <= p_date and (a.ends_on is null or a.ends_on >= p_date)
    and a.shift_id is not null
    and (a.employee_id = p_employee
         or (a.team_id is not null and a.team_id = e.team_id)
         or (a.work_location_id is not null and a.work_location_id = e.work_location_id))
  order by (a.employee_id is not null) desc, (a.team_id is not null) desc
  limit 1;

  if v_shift.starts_at is not null and v_in is not null then
    v_late := greatest(0, (extract(epoch from (
      v_in - (p_date::timestamp + v_shift.starts_at) at time zone
        (select timezone from public.org where id = p_org)
    )) / 60)::int);
  end if;
  if v_shift.ends_at is not null and v_out is not null then
    v_early := greatest(0, (extract(epoch from (
      (p_date::timestamp + v_shift.ends_at) at time zone
        (select timezone from public.org where id = p_org) - v_out
    )) / 60)::int);
    -- An overnight shift's end belongs to the next day.
    if v_shift.ends_at <= v_shift.starts_at then
      v_early := greatest(0, v_early - 1440);
    end if;
  end if;

  v_status := case
    when v_missing then 'present'
    when v_late > 0 then 'late'
    else 'present'
  end;

  select source into v_existing_source
  from public.attendance
  where org_id = p_org and employee_id = p_employee and attendance_date = p_date;

  insert into public.attendance
    (org_id, employee_id, attendance_date, status, source,
     check_in, check_out, worked_minutes, break_minutes,
     late_minutes, early_leave_minutes, missing_punch)
  values (p_org, p_employee, p_date, v_status, 'clock',
          v_in, v_out, v_worked, v_break, v_late, v_early, v_missing)
  on conflict (org_id, employee_id, attendance_date) do update
    set check_in = excluded.check_in,
        check_out = excluded.check_out,
        worked_minutes = excluded.worked_minutes,
        break_minutes = excluded.break_minutes,
        late_minutes = excluded.late_minutes,
        early_leave_minutes = excluded.early_leave_minutes,
        missing_punch = excluded.missing_punch,
        -- Manual and leave marks keep their status; clock rows refresh it.
        status = case when public.attendance.source in ('manual', 'leave_request')
                      then public.attendance.status else excluded.status end,
        source = case when public.attendance.source in ('manual', 'leave_request')
                      then public.attendance.source else 'clock' end,
        updated_at = now();
end;
$$;
revoke all on function app.rollup_attendance_day(uuid, uuid, date) from public;
grant execute on function app.rollup_attendance_day(uuid, uuid, date) to app_user;

-- ── attendance corrections: reason + approval, applied on approve ────────────
create table public.attendance_correction (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  attendance_date date not null,
  requested_in timestamptz,
  requested_out timestamptz,
  requested_status text check (requested_status is null or requested_status in
    ('present', 'absent', 'leave', 'half_day', 'sick', 'late')),
  reason text not null check (length(trim(reason)) between 1 and 500),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid references public.user_profile (id),
  decided_at timestamptz,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint attendance_correction_id_org_uq unique (id, org_id),
  constraint attendance_correction_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint attendance_correction_content_ck check (
    requested_in is not null or requested_out is not null or requested_status is not null)
);
create index attendance_correction_org_idx
  on public.attendance_correction (org_id, status, attendance_date);
alter table public.attendance_correction enable row level security;
create policy attendance_correction_select on public.attendance_correction
  for select to app_user
  using (org_id = (select app.current_org_id())
         and ((select app.current_archetype()) in ('owner', 'admin', 'manager', 'accounts')
              or employee_id = (select app.current_employee_id())));
create policy attendance_correction_insert on public.attendance_correction
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and (employee_id = (select app.current_employee_id())
                   or (select app.current_archetype()) in ('owner', 'admin', 'manager')));
create policy attendance_correction_update on public.attendance_correction
  for update to app_user
  using (org_id = (select app.current_org_id())
         and (select app.current_archetype()) in ('owner', 'admin', 'manager'))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.attendance_correction to app_user;
grant update (status, decided_by, decided_at) on public.attendance_correction to app_user;

-- ── overtime requests (through the approval engine) ──────────────────────────
create table public.overtime_request (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  work_date date not null,
  minutes integer not null check (minutes between 1 and 960),
  reason text not null check (length(trim(reason)) between 1 and 500),
  status text not null default 'draft'
    check (status in ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint overtime_request_id_org_uq unique (id, org_id),
  constraint overtime_request_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict
);
create unique index overtime_request_live_uq
  on public.overtime_request (org_id, employee_id, work_date)
  where status in ('pending', 'approved');
alter table public.overtime_request enable row level security;
create policy overtime_request_select on public.overtime_request
  for select to app_user
  using (org_id = (select app.current_org_id())
         and ((select app.current_archetype()) in ('owner', 'admin', 'manager', 'accounts')
              or employee_id = (select app.current_employee_id())));
create policy overtime_request_insert on public.overtime_request
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and (employee_id = (select app.current_employee_id())
                   or (select app.current_archetype()) in ('owner', 'admin', 'manager')));
create policy overtime_request_update on public.overtime_request
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.overtime_request to app_user;
grant update (minutes, reason, status, updated_at) on public.overtime_request to app_user;

-- ── leave: types, versioned policies, ledger, requests ───────────────────────
create table public.leave_type (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label jsonb not null, -- {en, ar}
  paid boolean not null default true,
  requires_attachment boolean not null default false,
  count_basis text not null default 'working_days'
    check (count_basis in ('working_days', 'calendar_days')),
  allow_half_day boolean not null default true,
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leave_type_id_org_uq unique (id, org_id),
  constraint leave_type_key_uq unique (org_id, key)
);
alter table public.leave_type enable row level security;
create policy leave_type_select on public.leave_type
  for select to app_user using (org_id = (select app.current_org_id()));
create policy leave_type_write on public.leave_type
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy leave_type_update on public.leave_type
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.leave_type to app_user;
grant update (label, paid, requires_attachment, count_basis, allow_half_day, sort, active, updated_at)
  on public.leave_type to app_user;

-- Versioned policy: a new version supersedes; approved history keeps pointing
-- at the version that governed it.
create table public.leave_policy (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  leave_type_id uuid not null,
  version integer not null check (version >= 1),
  accrual_basis text not null default 'annual_fixed'
    check (accrual_basis in ('annual_fixed', 'monthly_accrual', 'none')),
  annual_days numeric(5, 2) check (annual_days is null or annual_days between 0 and 365),
  monthly_accrual_days numeric(5, 2)
    check (monthly_accrual_days is null or monthly_accrual_days between 0 and 31),
  carryover_cap_days numeric(5, 2)
    check (carryover_cap_days is null or carryover_cap_days >= 0),
  min_service_months integer check (min_service_months is null or min_service_months >= 0),
  -- Free-form tier notes (e.g. sick-pay tiers) carried into calculations by the
  -- country pack, versioned HERE so a later change never rewrites history.
  rules jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint leave_policy_id_org_uq unique (id, org_id),
  constraint leave_policy_version_uq unique (org_id, leave_type_id, version),
  constraint leave_policy_type_fk foreign key (leave_type_id, org_id)
    references public.leave_type (id, org_id) on delete restrict
);
create unique index leave_policy_active_uq
  on public.leave_policy (org_id, leave_type_id) where active;
alter table public.leave_policy enable row level security;
create policy leave_policy_select on public.leave_policy
  for select to app_user using (org_id = (select app.current_org_id()));
create policy leave_policy_insert on public.leave_policy
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy leave_policy_update on public.leave_policy
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.leave_policy to app_user;
grant update (active) on public.leave_policy to app_user;

-- The balance LEDGER: append-only signed days. Balance = sum. No stored
-- balance column anywhere, so nothing can drift.
create table public.leave_ledger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  leave_type_id uuid not null,
  kind text not null check (kind in
    ('opening', 'accrual', 'carryover', 'request', 'cancellation', 'adjustment', 'expiry')),
  days numeric(6, 2) not null check (days <> 0),
  effective_date date not null default current_date,
  leave_request_id uuid,
  policy_id uuid,
  note text check (note is null or length(note) <= 300),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint leave_ledger_id_org_uq unique (id, org_id),
  constraint leave_ledger_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint leave_ledger_type_fk foreign key (leave_type_id, org_id)
    references public.leave_type (id, org_id) on delete restrict
);
create index leave_ledger_org_emp_idx
  on public.leave_ledger (org_id, employee_id, leave_type_id, effective_date);
alter table public.leave_ledger enable row level security;
create policy leave_ledger_select on public.leave_ledger
  for select to app_user
  using (org_id = (select app.current_org_id())
         and ((select app.current_archetype()) in ('owner', 'admin', 'manager', 'accounts', 'viewer')
              or employee_id = (select app.current_employee_id())));
create policy leave_ledger_insert on public.leave_ledger
  for insert to app_user with check (org_id = (select app.current_org_id()));
grant select, insert on public.leave_ledger to app_user;
create trigger leave_ledger_append_only
  before update or delete on public.leave_ledger
  for each row execute function app.employment_history_is_append_only();

create table public.leave_request (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  leave_type_id uuid not null,
  start_date date not null,
  end_date date not null,
  -- Partial days: a half-day start and/or end. A single half day is
  -- start=end + one flag.
  half_day_start boolean not null default false,
  half_day_end boolean not null default false,
  days numeric(6, 2) not null check (days > 0),
  reason text check (reason is null or length(reason) <= 1000),
  attachment_file_id uuid references public.file (id),
  policy_id uuid,
  status text not null default 'draft'
    check (status in ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 300),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leave_request_id_org_uq unique (id, org_id),
  constraint leave_request_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint leave_request_type_fk foreign key (leave_type_id, org_id)
    references public.leave_type (id, org_id) on delete restrict,
  constraint leave_request_span_ck check (end_date >= start_date),
  /*
   * OVERLAP PREVENTION AT THE DATABASE: two live (pending/approved) requests
   * for one employee may not share a day. An exclusion constraint, because a
   * unique index cannot say "ranges must not intersect".
   */
  constraint leave_request_no_overlap exclude using gist (
    org_id with =,
    employee_id with =,
    daterange(start_date, end_date, '[]') with &&
  ) where (status in ('pending', 'approved'))
);
create index leave_request_org_emp_idx
  on public.leave_request (org_id, employee_id, start_date desc);
alter table public.leave_request enable row level security;
create policy leave_request_select on public.leave_request
  for select to app_user
  using (org_id = (select app.current_org_id())
         and ((select app.current_archetype()) in ('owner', 'admin', 'manager', 'accounts', 'viewer')
              or employee_id = (select app.current_employee_id())));
create policy leave_request_insert on public.leave_request
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and (employee_id = (select app.current_employee_id())
                   or (select app.current_archetype()) in ('owner', 'admin', 'manager')));
create policy leave_request_update on public.leave_request
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.leave_request to app_user;
grant update (status, days, reason, attachment_file_id, policy_id,
              cancelled_at, cancel_reason, updated_at)
  on public.leave_request to app_user;

/*
 * Resolve an approved request into the canonical attendance table, one row per
 * WORKING day in the span (the caller passes the concrete dates so the day
 * arithmetic lives in one place, the service). Leave WINS over manual marks:
 * the approved request is the document of record for those days.
 */
create or replace function app.resolve_leave_days(
  p_org uuid, p_request uuid, p_employee uuid, p_status text, p_dates date[]
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  d date;
begin
  if p_status not in ('leave', 'sick', 'half_day') then
    raise exception 'illegal leave day status %', p_status;
  end if;
  foreach d in array p_dates loop
    insert into public.attendance (org_id, employee_id, attendance_date, status, source, note)
    values (p_org, p_employee, d, p_status, 'leave_request', p_request::text)
    on conflict (org_id, employee_id, attendance_date) do update
      set status = excluded.status,
          source = 'leave_request',
          note = excluded.note,
          updated_at = now();
  end loop;
end;
$$;
revoke all on function app.resolve_leave_days(uuid, uuid, uuid, text, date[]) from public;
grant execute on function app.resolve_leave_days(uuid, uuid, uuid, text, date[]) to app_user;

/*
 * Un-resolve a cancelled request: delete ONLY the attendance rows this request
 * itself created, and only from today forward. Past days stay — they are what
 * actually happened. The attendance rows here are a projection of the request;
 * the request and its ledger entries remain the history.
 */
create or replace function app.revert_leave_days(
  p_org uuid, p_request uuid, p_employee uuid
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  n integer;
begin
  delete from public.attendance
  where org_id = p_org and employee_id = p_employee
    and source = 'leave_request' and note = p_request::text
    and attendance_date >= current_date;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function app.revert_leave_days(uuid, uuid, uuid) from public;
grant execute on function app.revert_leave_days(uuid, uuid, uuid) to app_user;
