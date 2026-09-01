-- ═════════════════════════════════════════════════════════════════════════════
-- H23D — payroll: a deterministic, auditable financial subsystem.
--
-- Everything money sits behind the cost-privilege wall the same way
-- employee_terms has since S1. A finalized run and an issued payslip are
-- IMMUTABLE at the database — triggers, not grants, because neither RLS nor a
-- withheld grant binds the table owner. Corrections are reversal or off-cycle
-- runs, never edits. Every line carries a full calculation snapshot: inputs,
-- pack version, arithmetic — so nothing issued can silently change when an
-- employee, policy or salary changes later.
-- ═════════════════════════════════════════════════════════════════════════════

create table public.pay_group (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name_en text not null check (length(trim(name_en)) between 1 and 120),
  name_ar text check (name_ar is null or length(name_ar) <= 120),
  frequency text not null default 'monthly'
    check (frequency in ('monthly', 'weekly', 'biweekly', 'custom')),
  -- Net rounding: round HALF UP to the nearest N minor units. 1 = no rounding.
  rounding_minor integer not null default 1 check (rounding_minor in (1, 5, 10, 25, 50, 100)),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pay_group_id_org_uq unique (id, org_id)
);
alter table public.pay_group enable row level security;
create policy pay_group_all on public.pay_group
  for all to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()))
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
-- ONE active pay group per organization: every calculate covers every employee
-- (there is no group membership), so a second active group would pay everyone
-- twice. Enforced here until group membership exists.
create unique index pay_group_one_active_uq on public.pay_group (org_id) where active;
grant select, insert on public.pay_group to app_user;
grant update (name_en, name_ar, frequency, rounding_minor, active, updated_at)
  on public.pay_group to app_user;

create table public.pay_period (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  pay_group_id uuid not null,
  period_start date not null,
  period_end date not null,
  constraint pay_period_id_org_uq unique (id, org_id),
  constraint pay_period_uq unique (org_id, pay_group_id, period_start, period_end),
  constraint pay_period_group_fk foreign key (pay_group_id, org_id)
    references public.pay_group (id, org_id) on delete restrict,
  constraint pay_period_span_ck check (period_end >= period_start)
);
alter table public.pay_period enable row level security;
create policy pay_period_all on public.pay_period
  for all to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()))
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select, insert on public.pay_period to app_user;
grant update (period_end) on public.pay_period to app_user; -- ensurePeriod upsert

-- ── components: the vocabulary of a payslip ──────────────────────────────────
create table public.pay_component_def (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label jsonb not null, -- {en, ar}
  kind text not null check (kind in ('earning', 'deduction', 'employer_contribution')),
  calc text not null default 'fixed'
    check (calc in ('fixed', 'percent_of_basic', 'overtime', 'manual')),
  percent numeric(6, 3) check (percent is null or (percent >= 0 and percent <= 100)),
  recurring boolean not null default true,
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pay_component_def_id_org_uq unique (id, org_id),
  constraint pay_component_def_key_uq unique (org_id, key)
);
alter table public.pay_component_def enable row level security;
create policy pay_component_def_all on public.pay_component_def
  for all to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()))
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select, insert on public.pay_component_def to app_user;
grant update (label, kind, calc, percent, recurring, sort, active, updated_at)
  on public.pay_component_def to app_user;

-- Recurring per-employee amounts (allowances, fixed deductions). BASIC PAY IS
-- NOT HERE — it comes from employee_compensation, the one wage history.
create table public.employee_pay_component (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  component_id uuid not null,
  amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  effective_from date not null,
  effective_to date,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint employee_pay_component_id_org_uq unique (id, org_id),
  constraint employee_pay_component_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint employee_pay_component_def_fk foreign key (component_id, org_id)
    references public.pay_component_def (id, org_id) on delete restrict,
  constraint employee_pay_component_span_ck
    check (effective_to is null or effective_to >= effective_from)
);
create index employee_pay_component_emp_idx
  on public.employee_pay_component (org_id, employee_id, effective_from);
alter table public.employee_pay_component enable row level security;
create policy employee_pay_component_all on public.employee_pay_component
  for all to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()))
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select, insert on public.employee_pay_component to app_user;
grant update (effective_to) on public.employee_pay_component to app_user;

-- ── loans and advances ───────────────────────────────────────────────────────
create table public.employee_loan (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  kind text not null default 'loan' check (kind in ('loan', 'salary_advance')),
  reference text not null,
  principal_minor bigint not null check (principal_minor > 0),
  installment_minor bigint not null check (installment_minor > 0),
  starts_on date not null,
  reason text check (reason is null or length(reason) <= 500),
  status text not null default 'active' check (status in ('active', 'settled', 'written_off')),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_loan_id_org_uq unique (id, org_id),
  constraint employee_loan_ref_uq unique (org_id, reference),
  constraint employee_loan_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict
);
alter table public.employee_loan enable row level security;
create policy employee_loan_all on public.employee_loan
  for all to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()))
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select, insert on public.employee_loan to app_user;
grant update (status, installment_minor, updated_at) on public.employee_loan to app_user;

-- Repayments append per finalized run; balance = principal − sum(repayments).
create table public.loan_repayment (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  loan_id uuid not null,
  pay_run_id uuid,
  amount_minor bigint not null check (amount_minor > 0),
  created_at timestamptz not null default now(),
  constraint loan_repayment_id_org_uq unique (id, org_id),
  constraint loan_repayment_loan_fk foreign key (loan_id, org_id)
    references public.employee_loan (id, org_id) on delete restrict
);
alter table public.loan_repayment enable row level security;
create policy loan_repayment_all on public.loan_repayment
  for all to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()))
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select, insert on public.loan_repayment to app_user;
create trigger loan_repayment_append_only
  before update or delete on public.loan_repayment
  for each row execute function app.employment_history_is_append_only();

-- ── adjustments: manual, reasoned, per employee per run ──────────────────────
create table public.payroll_adjustment (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  pay_run_id uuid,
  kind text not null check (kind in ('earning', 'deduction')),
  label text not null check (length(trim(label)) between 1 and 160),
  amount_minor bigint not null check (amount_minor > 0),
  reason text not null check (length(trim(reason)) between 1 and 500),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint payroll_adjustment_id_org_uq unique (id, org_id),
  constraint payroll_adjustment_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict
);
create index payroll_adjustment_emp_idx
  on public.payroll_adjustment (org_id, employee_id, pay_run_id);
alter table public.payroll_adjustment enable row level security;
create policy payroll_adjustment_all on public.payroll_adjustment
  for all to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()))
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select, insert on public.payroll_adjustment to app_user;

-- ── the run ──────────────────────────────────────────────────────────────────
create table public.pay_run (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  pay_group_id uuid not null,
  period_id uuid not null,
  reference text not null,
  run_kind text not null default 'regular'
    check (run_kind in ('regular', 'off_cycle', 'final_settlement', 'reversal')),
  reverses_run_id uuid,
  status text not null default 'draft' check (status in
    ('draft', 'review', 'awaiting_approval', 'approved', 'finalized', 'cancelled')),
  pack_version text not null,
  currency char(3) not null,
  gross_total_minor bigint not null default 0 check (gross_total_minor >= 0),
  deduction_total_minor bigint not null default 0,
  employer_total_minor bigint not null default 0 check (employer_total_minor >= 0),
  net_total_minor bigint not null default 0,
  exception_count integer not null default 0,
  calculated_at timestamptz,
  finalized_at timestamptz,
  finalized_by uuid references public.user_profile (id),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pay_run_id_org_uq unique (id, org_id),
  constraint pay_run_ref_uq unique (org_id, reference),
  constraint pay_run_group_fk foreign key (pay_group_id, org_id)
    references public.pay_group (id, org_id) on delete restrict,
  constraint pay_run_period_fk foreign key (period_id, org_id)
    references public.pay_period (id, org_id) on delete restrict,
  constraint pay_run_reverses_fk foreign key (reverses_run_id, org_id)
    references public.pay_run (id, org_id) on delete restrict,
  constraint pay_run_finalized_ck
    check (status <> 'finalized' or (finalized_at is not null and finalized_by is not null))
);
/*
 * ONE live regular run per period: retries and double-clicks cannot mint a
 * second. Off-cycle/settlement/reversal runs are exempt by design.
 */
create unique index pay_run_one_regular_uq
  on public.pay_run (org_id, pay_group_id, period_id)
  where run_kind = 'regular' and status <> 'cancelled';
create index pay_run_org_idx on public.pay_run (org_id, status, created_at desc);
alter table public.pay_run enable row level security;
create policy pay_run_all on public.pay_run
  for all to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()))
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select, insert on public.pay_run to app_user;
grant update (status, gross_total_minor, deduction_total_minor, employer_total_minor,
              net_total_minor, exception_count, calculated_at, finalized_at, finalized_by,
              updated_at)
  on public.pay_run to app_user;

/*
 * The status machine and the freeze, AT THE DATABASE.
 *   draft → review → awaiting_approval → approved → finalized
 *   review → draft (recalculate) ; awaiting_approval → review (rejected)
 *   draft/review → cancelled
 * A FINALIZED run accepts no change at all. Approval-engine transitions pass
 * through the same trigger, so even the engine cannot bend the machine.
 */
create or replace function app.pay_run_status_guard()
returns trigger
language plpgsql
as $$
begin
  if current_setting('session_replication_role', true) = 'replica' then
    return new;
  end if;
  if old.status = 'finalized' then
    raise exception 'a finalized pay run is immutable; corrections are reversal or off-cycle runs'
      using errcode = 'restrict_violation';
  end if;
  if new.status is distinct from old.status then
    if not (
      (old.status = 'draft' and new.status in ('review', 'cancelled')) or
      (old.status = 'review' and new.status in ('draft', 'awaiting_approval', 'cancelled')) or
      (old.status = 'awaiting_approval' and new.status in ('approved', 'review')) or
      (old.status = 'approved' and new.status in ('finalized', 'review'))
    ) then
      raise exception 'a pay run cannot move from % to %', old.status, new.status
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger pay_run_status_guard
  before update on public.pay_run
  for each row execute function app.pay_run_status_guard();
create trigger pay_run_no_delete
  before delete on public.pay_run
  for each row execute function app.employment_history_is_append_only();

-- ── the lines and their components ───────────────────────────────────────────
create table public.pay_run_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  pay_run_id uuid not null,
  employee_id uuid not null,
  -- The COMPLETE calculation record: inputs, intermediate arithmetic, pack
  -- version, exceptions. What the payslip and every later question read.
  snapshot jsonb not null,
  gross_minor bigint not null check (gross_minor >= 0),
  deduction_minor bigint not null default 0 check (deduction_minor >= 0),
  employer_minor bigint not null default 0 check (employer_minor >= 0),
  net_minor bigint not null,
  exceptions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint pay_run_line_id_org_uq unique (id, org_id),
  constraint pay_run_line_uq unique (org_id, pay_run_id, employee_id),
  constraint pay_run_line_run_fk foreign key (pay_run_id, org_id)
    references public.pay_run (id, org_id) on delete restrict,
  constraint pay_run_line_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint pay_run_line_net_ck check (net_minor = gross_minor - deduction_minor)
);
create index pay_run_line_run_idx on public.pay_run_line (org_id, pay_run_id);
alter table public.pay_run_line enable row level security;
/*
 * Cost wall for the org roles — PLUS the self clause: an employee may read the
 * line that pays THEM (their payslip's backing record), and nobody else's.
 */
create policy pay_run_line_select on public.pay_run_line
  for select to app_user
  using (org_id = (select app.current_org_id())
         and ((select app.is_cost_privileged())
              or employee_id = (select app.current_employee_id())));
create policy pay_run_line_write on public.pay_run_line
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
create policy pay_run_line_update on public.pay_run_line
  for update to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()))
  with check (org_id = (select app.current_org_id()));
create policy pay_run_line_delete on public.pay_run_line
  for delete to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select, insert, update, delete on public.pay_run_line to app_user;

-- A line of a finalized run is frozen; recalculation deletes lines only while
-- the run is draft/review (delete IS the recalculation mechanism, so it stays
-- granted but the trigger scopes it to unfinalized runs).
create or replace function app.pay_run_line_frozen_when_final()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  if current_setting('session_replication_role', true) = 'replica' then
    return coalesce(new, old);
  end if;
  select status into v_status from public.pay_run
  where id = coalesce(new.pay_run_id, old.pay_run_id)
    and org_id = coalesce(new.org_id, old.org_id);
  if v_status in ('finalized', 'awaiting_approval', 'approved') then
    raise exception 'lines of a % run cannot change; recalculate from review', v_status
      using errcode = 'restrict_violation';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger pay_run_line_frozen
  before update or delete on public.pay_run_line
  for each row execute function app.pay_run_line_frozen_when_final();

-- ── payslips: issued, numbered, immutable ────────────────────────────────────
create table public.payslip (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  pay_run_id uuid not null,
  pay_run_line_id uuid not null,
  employee_id uuid not null,
  slip_no text not null,
  -- Frozen at issuance: org identity for the document header, and the full
  -- calculation. A later rename, logo change or salary change touches nothing.
  issuer_snapshot jsonb not null,
  snapshot jsonb not null,
  net_minor bigint not null,
  currency char(3) not null,
  period_start date not null,
  period_end date not null,
  issued_at timestamptz not null default now(),
  issued_by uuid not null references public.user_profile (id),
  constraint payslip_id_org_uq unique (id, org_id),
  constraint payslip_no_uq unique (org_id, slip_no),
  constraint payslip_line_uq unique (org_id, pay_run_line_id),
  constraint payslip_run_fk foreign key (pay_run_id, org_id)
    references public.pay_run (id, org_id) on delete restrict,
  constraint payslip_line_fk foreign key (pay_run_line_id, org_id)
    references public.pay_run_line (id, org_id) on delete restrict,
  constraint payslip_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict
);
create index payslip_org_emp_idx on public.payslip (org_id, employee_id, issued_at desc);
alter table public.payslip enable row level security;
-- Cost wall OR the employee's own slip.
create policy payslip_select on public.payslip
  for select to app_user
  using (org_id = (select app.current_org_id())
         and ((select app.is_cost_privileged())
              or employee_id = (select app.current_employee_id())));
create policy payslip_insert on public.payslip
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select, insert on public.payslip to app_user;
create trigger payslip_immutable
  before update or delete on public.payslip
  for each row execute function app.employment_history_is_append_only();

-- ── payout batches: the money-out record ─────────────────────────────────────
create table public.payout_batch (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  pay_run_id uuid,
  reference text not null,
  method text not null default 'bank' check (method in ('bank', 'wps', 'cash', 'cheque')),
  amount_minor bigint not null check (amount_minor >= 0),
  currency char(3) not null,
  status text not null default 'prepared'
    check (status in ('prepared', 'exported', 'paid', 'failed')),
  export_format text,
  idempotency_key text,
  note text check (note is null or length(note) <= 500),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payout_batch_id_org_uq unique (id, org_id),
  constraint payout_batch_ref_uq unique (org_id, reference),
  constraint payout_batch_idem_uq unique (org_id, idempotency_key),
  constraint payout_batch_run_fk foreign key (pay_run_id, org_id)
    references public.pay_run (id, org_id) on delete restrict
);
alter table public.payout_batch enable row level security;
create policy payout_batch_all on public.payout_batch
  for all to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()))
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select, insert on public.payout_batch to app_user;
grant update (status, export_format, note, updated_at) on public.payout_batch to app_user;
