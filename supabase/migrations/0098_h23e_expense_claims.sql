-- ═════════════════════════════════════════════════════════════════════════════
-- H23E — employee expense claims, cash advances and mileage.
--
-- The claim is a WORKFLOW that feeds the canon, never a second cost channel.
-- The S5 `expense` table remains the org's one expense book: an approved claim
-- settles EITHER through payroll (reimbursement on the next run) OR by posting
-- one canonical expense row — one purchase counted once, enforced by the
-- settled_* latches below. Draft claims never touch job cost.
-- ═════════════════════════════════════════════════════════════════════════════

create table public.expense_claim (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  reference text not null,
  title text not null check (length(trim(title)) between 1 and 200),
  currency char(3) not null,
  -- Foreign-currency claims carry the 0087 manual-rate column set; same-currency
  -- claims pin rate 1. No invented rates: a person enters it, audited.
  base_currency char(3) not null,
  exchange_rate numeric(18, 8) not null default 1 check (exchange_rate > 0),
  rate_source text not null default 'same_currency'
    check (rate_source in ('same_currency', 'manual')),
  total_minor bigint not null default 0 check (total_minor >= 0),
  base_total_minor bigint not null default 0 check (base_total_minor >= 0),
  status text not null default 'draft' check (status in
    ('draft', 'submitted', 'returned', 'approved', 'paid', 'cancelled')),
  settlement_route text not null default 'payroll'
    check (settlement_route in ('payroll', 'expense_book')),
  -- The no-double-pay latches: exactly one settlement, recorded forever.
  settled_pay_run_id uuid,
  settled_expense_id uuid,
  decision_note text check (decision_note is null or length(decision_note) <= 500),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expense_claim_id_org_uq unique (id, org_id),
  constraint expense_claim_ref_uq unique (org_id, reference),
  constraint expense_claim_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint expense_claim_settled_expense_fk foreign key (settled_expense_id, org_id)
    references public.expense (id, org_id) on delete restrict,
  constraint expense_claim_rate_ck check (
    (currency = base_currency and exchange_rate = 1 and rate_source = 'same_currency')
    or (currency <> base_currency and rate_source = 'manual')),
  constraint expense_claim_one_settlement_ck check (
    settled_pay_run_id is null or settled_expense_id is null)
);
create index expense_claim_org_emp_idx
  on public.expense_claim (org_id, employee_id, status);
alter table public.expense_claim enable row level security;
-- Self-or-reviewer read; self-or-manager write; decisions via the engine.
create policy expense_claim_select on public.expense_claim
  for select to app_user
  using (org_id = (select app.current_org_id())
         and ((select app.current_archetype()) in ('owner', 'admin', 'manager', 'accounts', 'procurement')
              or employee_id = (select app.current_employee_id())));
create policy expense_claim_insert on public.expense_claim
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and (employee_id = (select app.current_employee_id())
                   or (select app.current_archetype()) in ('owner', 'admin', 'manager', 'accounts')));
create policy expense_claim_update on public.expense_claim
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.expense_claim to app_user;
grant update (title, currency, base_currency, exchange_rate, rate_source,
              total_minor, base_total_minor, status, settlement_route,
              settled_pay_run_id, settled_expense_id, decision_note, updated_at)
  on public.expense_claim to app_user;

/*
 * A claim freezes at approval: after 'approved' the only legal movements are
 * settlement (approved → paid, stamping exactly one latch) — plus nothing.
 * Draft/returned stay editable; submitted is the engine's.
 */
create or replace function app.expense_claim_guard()
returns trigger
language plpgsql
as $$
begin
  if current_setting('session_replication_role', true) = 'replica' then
    return new;
  end if;
  if old.status in ('paid', 'cancelled') then
    raise exception 'a % claim is closed', old.status using errcode = 'restrict_violation';
  end if;
  if old.status = 'approved' then
    if new.status not in ('approved', 'paid') then
      raise exception 'an approved claim can only settle' using errcode = 'check_violation';
    end if;
    if new.total_minor is distinct from old.total_minor
       or new.currency is distinct from old.currency
       or new.exchange_rate is distinct from old.exchange_rate then
      raise exception 'an approved claim''s money is frozen' using errcode = 'restrict_violation';
    end if;
    if new.status = 'paid'
       and new.settled_pay_run_id is null and new.settled_expense_id is null then
      raise exception 'settlement must record HOW it was paid' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger expense_claim_guard
  before update on public.expense_claim
  for each row execute function app.expense_claim_guard();

create table public.expense_claim_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  claim_id uuid not null,
  expense_date date not null,
  category_key text not null check (length(category_key) between 1 and 60),
  description text not null check (length(trim(description)) between 1 and 500),
  amount_minor bigint not null check (amount_minor > 0),
  -- Mileage lines: qty × configured rate, both recorded.
  mileage_km numeric(8, 1) check (mileage_km is null or mileage_km > 0),
  mileage_rate_minor bigint check (mileage_rate_minor is null or mileage_rate_minor >= 0),
  receipt_file_id uuid references public.file (id),
  job_id uuid,
  -- Expense-book settlement stamps the canonical expense row this line became —
  -- per LINE, so a job-tagged line lands in that job's cost, not a lump.
  settled_expense_id uuid,
  created_at timestamptz not null default now(),
  constraint expense_claim_line_id_org_uq unique (id, org_id),
  constraint expense_claim_line_settled_fk foreign key (settled_expense_id, org_id)
    references public.expense (id, org_id) on delete restrict,
  constraint expense_claim_line_claim_fk foreign key (claim_id, org_id)
    references public.expense_claim (id, org_id) on delete restrict,
  constraint expense_claim_line_job_fk foreign key (job_id, org_id)
    references public.job (id, org_id) on delete restrict,
  constraint expense_claim_line_mileage_ck check (
    (mileage_km is null) = (mileage_rate_minor is null))
);
create index expense_claim_line_claim_idx on public.expense_claim_line (org_id, claim_id);
-- Duplicate-receipt warning support: same employee, same date, same amount.
create index expense_claim_line_dup_idx
  on public.expense_claim_line (org_id, expense_date, amount_minor);
alter table public.expense_claim_line enable row level security;
create policy expense_claim_line_select on public.expense_claim_line
  for select to app_user
  using (org_id = (select app.current_org_id()));
create policy expense_claim_line_write on public.expense_claim_line
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy expense_claim_line_update on public.expense_claim_line
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
-- No DELETE (D-1.7): a wrong line is fixed by cancelling the draft claim and
-- filing again — lines are cheap, history is not.
grant select, insert, update on public.expense_claim_line to app_user;

-- Lines freeze with their claim: editable only while draft/returned. The ONE
-- exception is settlement stamping settled_expense_id on an approved claim —
-- and then nothing else on the row may move.
create or replace function app.expense_claim_line_frozen()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  if current_setting('session_replication_role', true) = 'replica' then
    return coalesce(new, old);
  end if;
  select status into v_status from public.expense_claim
  where id = coalesce(new.claim_id, old.claim_id)
    and org_id = coalesce(new.org_id, old.org_id);
  if tg_op = 'UPDATE'
     and v_status = 'approved'
     and old.settled_expense_id is null
     and new.settled_expense_id is not null
     and new.amount_minor = old.amount_minor
     and new.expense_date = old.expense_date
     and new.category_key = old.category_key
     and new.description = old.description
     and new.claim_id = old.claim_id
     and new.job_id is not distinct from old.job_id then
    return new;
  end if;
  if v_status not in ('draft', 'returned') then
    raise exception 'lines of a % claim cannot change', v_status
      using errcode = 'restrict_violation';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger expense_claim_line_frozen
  before update or delete on public.expense_claim_line
  for each row execute function app.expense_claim_line_frozen();

-- ── mileage rates (org-configured, effective-dated) ──────────────────────────
create table public.mileage_rate (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  rate_minor_per_km bigint not null check (rate_minor_per_km >= 0),
  effective_from date not null,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint mileage_rate_id_org_uq unique (id, org_id),
  constraint mileage_rate_uq unique (org_id, effective_from)
);
alter table public.mileage_rate enable row level security;
create policy mileage_rate_all on public.mileage_rate
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.mileage_rate to app_user;
grant update (rate_minor_per_km) on public.mileage_rate to app_user; -- same-date upsert

-- ── cash advances (settled against claims or repaid via payroll loans) ───────
create table public.cash_advance (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  reference text not null,
  amount_minor bigint not null check (amount_minor > 0),
  purpose text not null check (length(trim(purpose)) between 1 and 500),
  status text not null default 'open' check (status in ('open', 'settled', 'converted_to_loan')),
  settled_claim_id uuid,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cash_advance_id_org_uq unique (id, org_id),
  constraint cash_advance_ref_uq unique (org_id, reference),
  constraint cash_advance_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint cash_advance_settled_fk foreign key (settled_claim_id, org_id)
    references public.expense_claim (id, org_id) on delete restrict
);
alter table public.cash_advance enable row level security;
create policy cash_advance_select on public.cash_advance
  for select to app_user
  using (org_id = (select app.current_org_id())
         and ((select app.current_archetype()) in ('owner', 'admin', 'manager', 'accounts')
              or employee_id = (select app.current_employee_id())));
create policy cash_advance_write on public.cash_advance
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and (select app.current_archetype()) in ('owner', 'admin', 'accounts'));
create policy cash_advance_update on public.cash_advance
  for update to app_user
  using (org_id = (select app.current_org_id())
         and (select app.current_archetype()) in ('owner', 'admin', 'accounts'))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.cash_advance to app_user;
grant update (status, settled_claim_id, updated_at) on public.cash_advance to app_user;
