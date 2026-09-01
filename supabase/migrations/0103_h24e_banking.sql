-- ═════════════════════════════════════════════════════════════════════════════
-- H24E — cash, banking and reconciliation.
--
-- money_transaction is the missing canonical document for money that is not a
-- customer invoice receipt: supplier payments, transfers, petty cash, charges,
-- interest, other receipts. It posts through the same ledger rules.
--
-- Statements import with file AND line hashes (duplicate detection at both
-- levels); reconciliation matches statement lines to LEDGER lines on the bank
-- account (the canonical side), supports 1:1 / 1:N / N:1 / partial via
-- per-row amounts, and LOCKS on completion. Suggestions live in the service
-- and never auto-match (truth map D9).
-- ═════════════════════════════════════════════════════════════════════════════

create table public.bank_account (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 120),
  kind text not null default 'bank'
    check (kind in ('bank', 'cash', 'petty_cash', 'card_clearing')),
  gl_account_id uuid not null,
  currency char(3) not null,
  account_no text check (account_no is null or length(account_no) <= 40),
  iban text check (iban is null or length(iban) <= 40),
  bank_name text check (bank_name is null or length(bank_name) <= 120),
  cheques_enabled boolean not null default false,
  active boolean not null default true,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bank_account_id_org_uq unique (id, org_id),
  constraint bank_account_name_uq unique (org_id, name),
  constraint bank_account_gl_fk foreign key (gl_account_id, org_id)
    references public.gl_account (id, org_id) on delete restrict,
  constraint bank_account_gl_uq unique (org_id, gl_account_id)
);
alter table public.bank_account enable row level security;
create policy bank_account_all on public.bank_account
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.bank_account to app_user;
grant update (name, account_no, iban, bank_name, cheques_enabled, active, updated_at)
  on public.bank_account to app_user;

create table public.money_transaction (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,
  kind text not null check (kind in
    ('receipt', 'payment', 'transfer', 'bank_charge', 'bank_interest')),
  bank_account_id uuid not null,
  counter_bank_account_id uuid,
  party_kind text check (party_kind is null or party_kind in
    ('customer', 'supplier', 'employee', 'other')),
  customer_id uuid,
  supplier_id uuid,
  employee_id uuid,
  -- For party 'other' (or none): the explicit account the money maps to —
  -- never a silent default.
  contra_account_id uuid,
  txn_date date not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  exchange_rate numeric(18, 8) not null default 1 check (exchange_rate > 0),
  base_amount_minor bigint not null check (base_amount_minor > 0),
  memo text check (memo is null or length(memo) <= 500),
  cheque_no text check (cheque_no is null or length(cheque_no) <= 40),
  cheque_due_on date,
  status text not null default 'recorded' check (status in ('recorded', 'void')),
  voided_at timestamptz,
  void_reason text check (void_reason is null or length(void_reason) <= 300),
  voided_by uuid references public.user_profile (id),
  idempotency_key text,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint money_transaction_id_org_uq unique (id, org_id),
  constraint money_transaction_ref_uq unique (org_id, reference),
  constraint money_transaction_bank_fk foreign key (bank_account_id, org_id)
    references public.bank_account (id, org_id) on delete restrict,
  constraint money_transaction_counter_fk foreign key (counter_bank_account_id, org_id)
    references public.bank_account (id, org_id) on delete restrict,
  constraint money_transaction_customer_fk foreign key (customer_id, org_id)
    references public.customer (id, org_id) on delete restrict,
  constraint money_transaction_supplier_fk foreign key (supplier_id, org_id)
    references public.supplier (id, org_id) on delete restrict,
  constraint money_transaction_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint money_transaction_contra_fk foreign key (contra_account_id, org_id)
    references public.gl_account (id, org_id) on delete restrict,
  constraint money_transaction_transfer_ck check (
    (kind = 'transfer') = (counter_bank_account_id is not null)),
  constraint money_transaction_void_ck check (voided_at is null or void_reason is not null)
);
create unique index money_transaction_idem_uq
  on public.money_transaction (org_id, idempotency_key) where idempotency_key is not null;
create index money_transaction_org_idx
  on public.money_transaction (org_id, bank_account_id, txn_date);
alter table public.money_transaction enable row level security;
create policy money_transaction_all on public.money_transaction
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.money_transaction to app_user;
grant update (status, voided_at, void_reason, voided_by, memo, cheque_no, cheque_due_on, updated_at)
  on public.money_transaction to app_user;

/* Money vouchers freeze at record: only void (with reason) moves them. */
create or replace function app.money_transaction_guard()
returns trigger
language plpgsql
as $$
begin
  if current_setting('session_replication_role', true) = 'replica' then
    return new;
  end if;
  if old.status = 'void' then
    raise exception 'a void money transaction cannot change' using errcode = 'restrict_violation';
  end if;
  if new.amount_minor is distinct from old.amount_minor
     or new.currency is distinct from old.currency
     or new.exchange_rate is distinct from old.exchange_rate
     or new.txn_date is distinct from old.txn_date
     or new.kind is distinct from old.kind
     or new.bank_account_id is distinct from old.bank_account_id then
    raise exception 'a recorded money transaction is corrected by void + re-entry'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger money_transaction_guard
  before update on public.money_transaction
  for each row execute function app.money_transaction_guard();

-- ── statements ───────────────────────────────────────────────────────────────
create table public.bank_statement (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  bank_account_id uuid not null,
  label text not null check (length(trim(label)) between 1 and 120),
  file_hash text not null check (length(file_hash) = 64),
  line_count integer not null default 0,
  opening_balance_minor bigint,
  closing_balance_minor bigint,
  status text not null default 'imported' check (status in ('imported', 'void')),
  voided_at timestamptz,
  void_reason text check (void_reason is null or length(void_reason) <= 300),
  imported_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint bank_statement_id_org_uq unique (id, org_id),
  -- The SAME FILE cannot import twice for one bank account.
  constraint bank_statement_file_uq unique (org_id, bank_account_id, file_hash),
  constraint bank_statement_bank_fk foreign key (bank_account_id, org_id)
    references public.bank_account (id, org_id) on delete restrict,
  constraint bank_statement_void_ck check (voided_at is null or void_reason is not null)
);
alter table public.bank_statement enable row level security;
create policy bank_statement_all on public.bank_statement
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.bank_statement to app_user;
grant update (status, voided_at, void_reason, line_count, closing_balance_minor, opening_balance_minor)
  on public.bank_statement to app_user;

create table public.bank_statement_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  statement_id uuid not null,
  bank_account_id uuid not null,
  line_no integer not null,
  txn_date date not null,
  description text not null check (length(description) <= 500),
  -- Signed: positive money IN, negative money OUT.
  amount_minor bigint not null check (amount_minor <> 0),
  running_balance_minor bigint,
  external_ref text check (external_ref is null or length(external_ref) <= 120),
  -- Line identity across files: the same bank line re-imported in an
  -- overlapping statement is caught here.
  line_hash text not null check (length(line_hash) = 64),
  created_at timestamptz not null default now(),
  constraint bank_statement_line_id_org_uq unique (id, org_id),
  constraint bank_statement_line_no_uq unique (org_id, statement_id, line_no),
  constraint bank_statement_line_hash_uq unique (org_id, bank_account_id, line_hash),
  constraint bank_statement_line_stmt_fk foreign key (statement_id, org_id)
    references public.bank_statement (id, org_id) on delete restrict,
  constraint bank_statement_line_bank_fk foreign key (bank_account_id, org_id)
    references public.bank_account (id, org_id) on delete restrict
);
create index bank_statement_line_org_idx
  on public.bank_statement_line (org_id, bank_account_id, txn_date);
alter table public.bank_statement_line enable row level security;
create policy bank_statement_line_all on public.bank_statement_line
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.bank_statement_line to app_user;

-- ── reconciliation ───────────────────────────────────────────────────────────
create table public.bank_reconciliation (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  bank_account_id uuid not null,
  label text not null check (length(trim(label)) between 1 and 120),
  statement_closing_minor bigint,
  status text not null default 'in_progress'
    check (status in ('in_progress', 'completed')),
  started_by uuid not null references public.user_profile (id),
  started_at timestamptz not null default now(),
  completed_by uuid references public.user_profile (id),
  completed_at timestamptz,
  notes text check (notes is null or length(notes) <= 1000),
  constraint bank_reconciliation_id_org_uq unique (id, org_id),
  constraint bank_reconciliation_bank_fk foreign key (bank_account_id, org_id)
    references public.bank_account (id, org_id) on delete restrict
);
alter table public.bank_reconciliation enable row level security;
create policy bank_reconciliation_all on public.bank_reconciliation
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.bank_reconciliation to app_user;
grant update (status, completed_by, completed_at, notes, statement_closing_minor)
  on public.bank_reconciliation to app_user;

create table public.bank_match (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reconciliation_id uuid not null,
  statement_line_id uuid not null,
  journal_line_id uuid not null,
  amount_minor bigint not null check (amount_minor <> 0),
  matched_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  void_reason text check (void_reason is null or length(void_reason) <= 300),
  constraint bank_match_id_org_uq unique (id, org_id),
  constraint bank_match_recon_fk foreign key (reconciliation_id, org_id)
    references public.bank_reconciliation (id, org_id) on delete restrict,
  constraint bank_match_stmt_fk foreign key (statement_line_id, org_id)
    references public.bank_statement_line (id, org_id) on delete restrict,
  constraint bank_match_jl_fk foreign key (journal_line_id, org_id)
    references public.journal_line (id, org_id) on delete restrict,
  constraint bank_match_void_ck check (voided_at is null or void_reason is not null)
);
create index bank_match_recon_idx on public.bank_match (org_id, reconciliation_id)
  where voided_at is null;
create index bank_match_stmt_idx on public.bank_match (org_id, statement_line_id)
  where voided_at is null;
create index bank_match_jl_idx on public.bank_match (org_id, journal_line_id)
  where voided_at is null;
alter table public.bank_match enable row level security;
create policy bank_match_all on public.bank_match
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.bank_match to app_user;
grant update (voided_at, void_reason) on public.bank_match to app_user;

/* A COMPLETED reconciliation's matches are history: no new ones, no unmatching. */
create or replace function app.bank_match_frozen()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  if current_setting('session_replication_role', true) = 'replica' then
    return coalesce(new, old);
  end if;
  select status into v_status from public.bank_reconciliation
  where id = coalesce(new.reconciliation_id, old.reconciliation_id)
    and org_id = coalesce(new.org_id, old.org_id);
  if v_status is distinct from 'in_progress' then
    raise exception 'matches of a % reconciliation cannot change', v_status
      using errcode = 'restrict_violation';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger bank_match_frozen
  before insert or update on public.bank_match
  for each row execute function app.bank_match_frozen();
