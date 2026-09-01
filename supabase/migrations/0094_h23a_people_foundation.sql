-- ═════════════════════════════════════════════════════════════════════════════
-- H23A — the people foundation.
--
-- EXTENDS the canonical person model from 0020 (employee / employee_terms /
-- employee_hr); creates nothing parallel to it. An employee still needs no
-- login (employee.user_id stays nullable), and nothing here can erase
-- employment history: lifecycle rows are append-only, records void rather
-- than delete, and the tables that hold what a person was paid or who they
-- are sit behind the same two database walls 0020 established —
-- the cost-privilege GUC for money, the owner/admin archetype for identity.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── the self-scope helper ─────────────────────────────────────────────────────
-- "The employee row linked to the signed-in member, if any." Self-service RLS
-- clauses (my payslip, my leave) key on this. SECURITY DEFINER because the
-- caller may not otherwise be allowed to read the employee table at all.
create or replace function app.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select e.id from public.employee e
  where e.org_id = app.current_org_id()
    and e.user_id = app.current_user_id()
  limit 1
$$;
revoke all on function app.current_employee_id() from public;
grant execute on function app.current_employee_id() to app_user;

-- ── organizational structure: small reference tables ─────────────────────────
-- Flat + optional parent for departments; no DELETE grants anywhere (D-1.7 —
-- retire, never erase). All names bilingual because every screen is.

create table public.department (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  parent_id uuid,
  name_en text not null check (length(trim(name_en)) between 1 and 120),
  name_ar text check (name_ar is null or length(name_ar) <= 120),
  code text check (code is null or length(code) <= 24),
  cost_centre text check (cost_centre is null or length(cost_centre) <= 60),
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint department_id_org_uq unique (id, org_id),
  constraint department_parent_fk foreign key (parent_id, org_id)
    references public.department (id, org_id) on delete restrict,
  constraint department_not_own_parent_ck check (parent_id is null or parent_id <> id)
);
create index department_org_idx on public.department (org_id, active, sort);
alter table public.department enable row level security;
create policy department_select on public.department
  for select to app_user using (org_id = (select app.current_org_id()));
create policy department_write on public.department
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy department_update on public.department
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.department to app_user;
grant update (parent_id, name_en, name_ar, code, cost_centre, sort, active, updated_at)
  on public.department to app_user;

create table public.position (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name_en text not null check (length(trim(name_en)) between 1 and 120),
  name_ar text check (name_ar is null or length(name_ar) <= 120),
  department_id uuid,
  grade text check (grade is null or length(grade) <= 40),
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint position_id_org_uq unique (id, org_id),
  constraint position_department_fk foreign key (department_id, org_id)
    references public.department (id, org_id) on delete restrict
);
create index position_org_idx on public.position (org_id, active, sort);
alter table public.position enable row level security;
create policy position_select on public.position
  for select to app_user using (org_id = (select app.current_org_id()));
create policy position_insert on public.position
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy position_update on public.position
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.position to app_user;
grant update (name_en, name_ar, department_id, grade, sort, active, updated_at)
  on public.position to app_user;

create table public.work_location (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name_en text not null check (length(trim(name_en)) between 1 and 120),
  name_ar text check (name_ar is null or length(name_ar) <= 120),
  address text check (address is null or length(address) <= 400),
  country char(2) check (country is null or country ~ '^[A-Z]{2}$'),
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_location_id_org_uq unique (id, org_id)
);
create index work_location_org_idx on public.work_location (org_id, active, sort);
alter table public.work_location enable row level security;
create policy work_location_select on public.work_location
  for select to app_user using (org_id = (select app.current_org_id()));
create policy work_location_insert on public.work_location
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy work_location_update on public.work_location
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.work_location to app_user;
grant update (name_en, name_ar, address, country, sort, active, updated_at)
  on public.work_location to app_user;

-- ── employee: the canonical row grows up ─────────────────────────────────────
-- Everything nullable or defaulted, so 0020's existing production rows are
-- untouched data-wise; a backfill below derives lifecycle from `active`.

alter table public.employee
  add column employee_no text check (employee_no is null or length(employee_no) <= 24),
  add column legal_name text check (legal_name is null or length(legal_name) <= 160),
  add column name_ar text check (name_ar is null or length(name_ar) <= 160),
  add column email text check (email is null or length(email) <= 160),
  add column emergency_contact_name text
    check (emergency_contact_name is null or length(emergency_contact_name) <= 160),
  add column emergency_contact_phone text
    check (emergency_contact_phone is null or length(emergency_contact_phone) <= 32),
  add column emergency_contact_relation text
    check (emergency_contact_relation is null or length(emergency_contact_relation) <= 60),
  add column nationality char(2) check (nationality is null or nationality ~ '^[A-Z]{2}$'),
  add column residency_status text
    check (residency_status is null
           or residency_status in ('citizen', 'resident', 'work_permit', 'visitor', 'other')),
  add column department_id uuid,
  add column position_id uuid,
  add column work_location_id uuid,
  add column cost_centre text check (cost_centre is null or length(cost_centre) <= 60),
  add column manager_employee_id uuid,
  add column employment_type text not null default 'full_time'
    check (employment_type in
      ('full_time', 'part_time', 'contractor', 'intern', 'temporary', 'other')),
  /*
   * The lifecycle. `active` (0020) stays — costing, crew pickers and the grid
   * all read it — but it becomes a DERIVED projection of lifecycle (trigger
   * below), so the two can never disagree.
   */
  add column lifecycle text not null default 'active'
    check (lifecycle in ('draft', 'active', 'suspended', 'notice', 'terminated', 'archived')),
  add column hire_date date,
  add column probation_end_date date,
  add column confirmation_date date,
  add column notice_date date,
  add column end_date date,
  add column final_working_date date;

-- Existing rows: inactive employees were archived in every practical sense.
update public.employee set lifecycle = 'archived' where active = false;

alter table public.employee
  add constraint employee_no_org_uq unique (org_id, employee_no),
  add constraint employee_department_fk foreign key (department_id, org_id)
    references public.department (id, org_id) on delete restrict,
  add constraint employee_position_fk foreign key (position_id, org_id)
    references public.position (id, org_id) on delete restrict,
  add constraint employee_location_fk foreign key (work_location_id, org_id)
    references public.work_location (id, org_id) on delete restrict,
  add constraint employee_manager_fk foreign key (manager_employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  add constraint employee_not_own_manager_ck
    check (manager_employee_id is null or manager_employee_id <> id),
  add constraint employee_dates_ck
    check (end_date is null or hire_date is null or end_date >= hire_date);

create index employee_org_department_idx on public.employee (org_id, department_id);
create index employee_org_manager_idx on public.employee (org_id, manager_employee_id);
create index employee_org_lifecycle_idx on public.employee (org_id, lifecycle);

grant update (employee_no, legal_name, name_ar, email,
              emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
              nationality, residency_status,
              department_id, position_id, work_location_id, cost_centre,
              manager_employee_id, employment_type, lifecycle,
              hire_date, probation_end_date, confirmation_date,
              notice_date, end_date, final_working_date)
  on public.employee to app_user;

/*
 * Lifecycle legality + the derived `active` flag, enforced AT THE DATABASE.
 *
 *   draft      → active | archived
 *   active     → suspended | notice | terminated
 *   suspended  → active | terminated
 *   notice     → active (withdrawn) | terminated
 *   terminated → archived
 *   archived   → terminal (a rehire is a NEW employment period, not a state flip)
 *
 * A transition outside this set raises; equal-state writes pass so ordinary
 * profile updates never trip it. `active` is stamped from lifecycle on every
 * write, so nothing can leave the pair disagreeing.
 */
create or replace function app.employee_lifecycle_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.lifecycle is distinct from old.lifecycle then
    if not (
      (old.lifecycle = 'draft'      and new.lifecycle in ('active', 'archived')) or
      (old.lifecycle = 'active'     and new.lifecycle in ('suspended', 'notice', 'terminated')) or
      (old.lifecycle = 'suspended'  and new.lifecycle in ('active', 'terminated')) or
      (old.lifecycle = 'notice'     and new.lifecycle in ('active', 'terminated')) or
      (old.lifecycle = 'terminated' and new.lifecycle = 'archived')
    ) then
      raise exception 'an employee cannot move from % to %', old.lifecycle, new.lifecycle
        using errcode = 'check_violation';
    end if;
    -- Termination must say when.
    if new.lifecycle = 'terminated' and new.end_date is null then
      raise exception 'termination requires an end date' using errcode = 'check_violation';
    end if;
  end if;
  new.active := new.lifecycle in ('active', 'suspended', 'notice');
  return new;
end;
$$;
create trigger employee_lifecycle_guard
  before insert or update on public.employee
  for each row execute function app.employee_lifecycle_guard();

-- ── employee_event: the append-only employment history ───────────────────────
-- Every lifecycle change, transfer, promotion and compensation change leaves a
-- row here. detail carries identifiers and dates only — NEVER amounts (§5.9);
-- the amounts live behind the compensation wall.
create table public.employee_event (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  event text not null check (event in
    ('created', 'activated', 'suspended', 'notice_given', 'notice_withdrawn',
     'confirmed', 'probation_extended', 'transferred', 'promoted',
     'compensation_changed', 'contract_issued', 'contract_accepted',
     'terminated', 'archived', 'delegation_set', 'delegation_ended', 'note')),
  effective_date date not null default current_date,
  detail jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint employee_event_id_org_uq unique (id, org_id),
  constraint employee_event_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict
);
create index employee_event_org_emp_idx
  on public.employee_event (org_id, employee_id, effective_date desc);
alter table public.employee_event enable row level security;
create policy employee_event_select on public.employee_event
  for select to app_user using (org_id = (select app.current_org_id()));
create policy employee_event_insert on public.employee_event
  for insert to app_user with check (org_id = (select app.current_org_id()));
grant select, insert on public.employee_event to app_user;
-- Append-only BY TRIGGER, not by withheld grant: RLS without FORCE does not
-- bind the table owner, and neither does a missing grant (the H22B/H22E lesson).
create or replace function app.employment_history_is_append_only()
returns trigger
language plpgsql
as $$
begin
  if current_setting('session_replication_role', true) = 'replica' then
    return coalesce(new, old); -- test teardown / replication only
  end if;
  raise exception 'employment history is append-only; corrections are new events'
    using errcode = 'restrict_violation';
end;
$$;
create trigger employee_event_append_only
  before update or delete on public.employee_event
  for each row execute function app.employment_history_is_append_only();

-- ── employee_contract: contract history with an acceptance record ────────────
create table public.employee_contract (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  contract_no text not null check (length(contract_no) <= 32),
  contract_type text not null default 'fixed_term'
    check (contract_type in ('fixed_term', 'part_time_contract', 'temporary_contract', 'other')),
  start_date date not null,
  end_date date,
  probation_months integer check (probation_months is null or probation_months between 0 and 6),
  status text not null default 'draft'
    check (status in ('draft', 'issued', 'accepted', 'superseded', 'ended')),
  issued_at timestamptz,
  -- The acceptance RECORD: when, and through which channel the employee agreed.
  accepted_at timestamptz,
  accepted_channel text
    check (accepted_channel is null or accepted_channel in ('signed_paper', 'in_app', 'email', 'other')),
  notes text check (notes is null or length(notes) <= 2000),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_contract_id_org_uq unique (id, org_id),
  constraint employee_contract_no_uq unique (org_id, contract_no),
  constraint employee_contract_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint employee_contract_dates_ck check (end_date is null or end_date >= start_date),
  constraint employee_contract_accept_ck
    check (accepted_at is null or accepted_channel is not null)
);
create index employee_contract_org_emp_idx
  on public.employee_contract (org_id, employee_id, start_date desc);
alter table public.employee_contract enable row level security;
create policy employee_contract_select on public.employee_contract
  for select to app_user using (org_id = (select app.current_org_id()));
create policy employee_contract_insert on public.employee_contract
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy employee_contract_update on public.employee_contract
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.employee_contract to app_user;
-- Terms of a contract freeze at issue; only lifecycle columns stay writable.
grant update (status, issued_at, accepted_at, accepted_channel, notes, end_date, updated_at)
  on public.employee_contract to app_user;

create or replace function app.employee_contract_is_frozen_once_issued()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'draft'
     and (new.contract_type is distinct from old.contract_type
          or new.start_date is distinct from old.start_date
          or new.probation_months is distinct from old.probation_months) then
    raise exception 'an issued contract cannot change its terms; issue a new contract'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger employee_contract_frozen
  before update on public.employee_contract
  for each row execute function app.employee_contract_is_frozen_once_issued();

-- ── employee_compensation: effective-dated pay history (COST WALL) ───────────
-- The SOURCE OF TRUTH for what an employee is paid from a given date.
-- employee_terms (0020) remains as the CURRENT projection — the service writes
-- both in one transaction, so costing keeps reading the table it always has.
create table public.employee_compensation (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  effective_date date not null,
  salary_minor bigint not null check (salary_minor >= 0),
  hourly_cost_minor bigint not null check (hourly_cost_minor >= 0),
  ot_rate numeric(5, 2) not null default 1.25 check (ot_rate >= 0 and ot_rate <= 10),
  reason text not null default 'adjustment'
    check (reason in ('hire', 'annual_review', 'promotion', 'adjustment', 'correction', 'transfer')),
  note text check (note is null or length(note) <= 500),
  superseded_at timestamptz,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint employee_compensation_id_org_uq unique (id, org_id),
  constraint employee_compensation_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict
);
-- One LIVE row per employee per effective date; corrections supersede.
create unique index employee_compensation_live_uq
  on public.employee_compensation (org_id, employee_id, effective_date)
  where superseded_at is null;
create index employee_compensation_emp_idx
  on public.employee_compensation (org_id, employee_id, effective_date desc);
alter table public.employee_compensation enable row level security;
create policy employee_compensation_select on public.employee_compensation
  for select to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
create policy employee_compensation_insert on public.employee_compensation
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
create policy employee_compensation_update on public.employee_compensation
  for update to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()))
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select, insert on public.employee_compensation to app_user;
grant update (superseded_at) on public.employee_compensation to app_user;

-- ── employee_payment_instruction: how they are paid (COST WALL) ──────────────
create table public.employee_payment_instruction (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  method text not null default 'bank'
    check (method in ('bank', 'wps', 'cash', 'cheque')),
  bank_name text check (bank_name is null or length(bank_name) <= 160),
  iban text check (iban is null or length(iban) <= 34),
  account_no text check (account_no is null or length(account_no) <= 34),
  wps_agent_id text check (wps_agent_id is null or length(wps_agent_id) <= 23),
  wps_person_id text check (wps_person_id is null or length(wps_person_id) <= 14),
  note text check (note is null or length(note) <= 500),
  active boolean not null default true,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_payment_instruction_id_org_uq unique (id, org_id),
  constraint employee_payment_instruction_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict
);
create unique index employee_payment_instruction_active_uq
  on public.employee_payment_instruction (org_id, employee_id)
  where active;
alter table public.employee_payment_instruction enable row level security;
create policy employee_payment_instruction_select on public.employee_payment_instruction
  for select to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
create policy employee_payment_instruction_insert on public.employee_payment_instruction
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
create policy employee_payment_instruction_update on public.employee_payment_instruction
  for update to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()))
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select, insert on public.employee_payment_instruction to app_user;
grant update (method, bank_name, iban, account_no, wps_agent_id, wps_person_id,
              note, active, updated_at)
  on public.employee_payment_instruction to app_user;

-- ── configurable custom fields (ordinary-team tier) ──────────────────────────
create table public.employee_field_def (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label jsonb not null, -- {en, ar}
  kind text not null default 'text' check (kind in ('text', 'number', 'date', 'boolean')),
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_field_def_id_org_uq unique (id, org_id),
  constraint employee_field_def_key_uq unique (org_id, key)
);
alter table public.employee_field_def enable row level security;
create policy employee_field_def_all on public.employee_field_def
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.employee_field_def to app_user;
grant update (label, kind, sort, active, updated_at) on public.employee_field_def to app_user;

create table public.employee_field_value (
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  field_id uuid not null,
  value text check (value is null or length(value) <= 500),
  updated_by uuid not null references public.user_profile (id),
  updated_at timestamptz not null default now(),
  primary key (org_id, employee_id, field_id),
  constraint employee_field_value_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint employee_field_value_field_fk foreign key (field_id, org_id)
    references public.employee_field_def (id, org_id) on delete restrict
);
alter table public.employee_field_value enable row level security;
create policy employee_field_value_all on public.employee_field_value
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert, update on public.employee_field_value to app_user;

-- ── employee documents: metadata + expiry + versioning over the file store ───
-- The FILE BYTES live in the existing file table/storage walls (hr_doc class);
-- this registry adds what a file row cannot say: what the document IS, when it
-- expires, and which version replaced which.
create table public.employee_document (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  doc_type text not null check (doc_type in
    ('passport', 'national_id', 'visa', 'work_permit', 'contract', 'certificate',
     'medical', 'photo', 'other')),
  title text not null check (length(trim(title)) between 1 and 160),
  file_id uuid references public.file (id),
  expiry_date date,
  version integer not null default 1 check (version >= 1),
  replaces_id uuid,
  -- 'hr' rides the owner/admin wall (identity/medical); 'general' rides
  -- employees.view (certificates, photos). Chosen at upload, never widened by
  -- a later edit (column absent from the update grant).
  access_tier text not null default 'hr' check (access_tier in ('hr', 'general')),
  voided_at timestamptz,
  void_reason text check (void_reason is null or length(void_reason) <= 300),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_document_id_org_uq unique (id, org_id),
  constraint employee_document_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint employee_document_replaces_fk foreign key (replaces_id, org_id)
    references public.employee_document (id, org_id) on delete restrict,
  constraint employee_document_void_ck check (voided_at is null or void_reason is not null)
);
create index employee_document_org_emp_idx
  on public.employee_document (org_id, employee_id, doc_type);
create index employee_document_expiry_idx
  on public.employee_document (org_id, expiry_date) where expiry_date is not null;
alter table public.employee_document enable row level security;
-- The hr tier is readable only past the owner/admin wall; general is org-wide.
create policy employee_document_select on public.employee_document
  for select to app_user
  using (org_id = (select app.current_org_id())
         and (access_tier = 'general'
              or (select app.current_archetype()) in ('owner', 'admin')
              or employee_id = (select app.current_employee_id())));
create policy employee_document_insert on public.employee_document
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and ((select app.current_archetype()) in ('owner', 'admin')));
create policy employee_document_update on public.employee_document
  for update to app_user
  using (org_id = (select app.current_org_id())
         and (select app.current_archetype()) in ('owner', 'admin'))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.employee_document to app_user;
grant update (title, expiry_date, voided_at, void_reason, updated_at)
  on public.employee_document to app_user;

-- Who looked at a sensitive document, append-only.
create table public.employee_document_access (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  document_id uuid not null,
  action text not null check (action in ('view', 'download')),
  user_id uuid not null references public.user_profile (id),
  at timestamptz not null default now(),
  constraint employee_document_access_doc_fk foreign key (document_id, org_id)
    references public.employee_document (id, org_id) on delete restrict
);
create index employee_document_access_doc_idx
  on public.employee_document_access (org_id, document_id, at desc);
alter table public.employee_document_access enable row level security;
create policy employee_document_access_select on public.employee_document_access
  for select to app_user
  using (org_id = (select app.current_org_id())
         and (select app.current_archetype()) in ('owner', 'admin'));
create policy employee_document_access_insert on public.employee_document_access
  for insert to app_user with check (org_id = (select app.current_org_id()));
grant select, insert on public.employee_document_access to app_user;
create trigger employee_document_access_append_only
  before update or delete on public.employee_document_access
  for each row execute function app.employment_history_is_append_only();

-- ── disciplinary and grievance records (OWNER/ADMIN WALL) ────────────────────
create table public.disciplinary_record (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  kind text not null check (kind in ('verbal_warning', 'written_warning', 'final_warning',
                                     'grievance', 'investigation', 'note')),
  occurred_on date not null,
  summary text not null check (length(trim(summary)) between 1 and 200),
  detail text check (detail is null or length(detail) <= 4000),
  outcome text check (outcome is null or length(outcome) <= 1000),
  file_id uuid references public.file (id),
  voided_at timestamptz,
  void_reason text check (void_reason is null or length(void_reason) <= 300),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint disciplinary_record_id_org_uq unique (id, org_id),
  constraint disciplinary_record_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint disciplinary_record_void_ck check (voided_at is null or void_reason is not null)
);
create index disciplinary_record_org_emp_idx
  on public.disciplinary_record (org_id, employee_id, occurred_on desc);
alter table public.disciplinary_record enable row level security;
create policy disciplinary_record_all on public.disciplinary_record
  for all to app_user
  using (org_id = (select app.current_org_id())
         and (select app.current_archetype()) in ('owner', 'admin'))
  with check (org_id = (select app.current_org_id())
              and (select app.current_archetype()) in ('owner', 'admin'));
grant select, insert on public.disciplinary_record to app_user;
grant update (outcome, voided_at, void_reason, updated_at)
  on public.disciplinary_record to app_user;

-- ── temporary delegation of a manager's duties ───────────────────────────────
create table public.manager_delegation (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  from_employee_id uuid not null,
  to_employee_id uuid not null,
  starts_on date not null,
  ends_on date not null,
  reason text check (reason is null or length(reason) <= 300),
  created_by uuid not null references public.user_profile (id),
  ended_early_at timestamptz,
  created_at timestamptz not null default now(),
  constraint manager_delegation_id_org_uq unique (id, org_id),
  constraint manager_delegation_from_fk foreign key (from_employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint manager_delegation_to_fk foreign key (to_employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint manager_delegation_span_ck check (ends_on >= starts_on),
  constraint manager_delegation_not_self_ck check (from_employee_id <> to_employee_id)
);
create index manager_delegation_org_idx
  on public.manager_delegation (org_id, from_employee_id, starts_on);
alter table public.manager_delegation enable row level security;
create policy manager_delegation_select on public.manager_delegation
  for select to app_user using (org_id = (select app.current_org_id()));
create policy manager_delegation_insert on public.manager_delegation
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy manager_delegation_update on public.manager_delegation
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.manager_delegation to app_user;
grant update (ends_on, reason, ended_early_at) on public.manager_delegation to app_user;
