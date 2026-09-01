-- ═════════════════════════════════════════════════════════════════════════════
-- H24G/H — the rate book, budgets, and the versioned tax engine.
--
-- currency_rate is a book of SUGGESTIONS (manual or imported, effective
-- timestamps); every posting still snapshots its own explicit rate — nothing
-- is ever invented (truth map D10).
--
-- tax_code is versioned configuration; tax_entry is the FACT captured at
-- posting time (base, tax, direction, reporting box, code snapshot) so
-- returns are computed from captured facts; tax_return is a working paper
-- with review → lock → amend lifecycle (truth map D8).
-- ═════════════════════════════════════════════════════════════════════════════

create table public.currency_rate (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  from_currency char(3) not null,
  to_currency char(3) not null,
  rate numeric(18, 8) not null check (rate > 0),
  effective_at timestamptz not null,
  source text not null default 'manual' check (source in ('manual', 'import')),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint currency_rate_id_org_uq unique (id, org_id),
  constraint currency_rate_uq unique (org_id, from_currency, to_currency, effective_at),
  constraint currency_rate_pair_ck check (from_currency <> to_currency)
);
alter table public.currency_rate enable row level security;
create policy currency_rate_all on public.currency_rate
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.currency_rate to app_user;

-- ── budgets ──────────────────────────────────────────────────────────────────
create table public.budget (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  fiscal_year_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 120),
  version integer not null default 1 check (version >= 1),
  status text not null default 'draft' check (status in ('draft', 'approved', 'locked')),
  approved_by uuid references public.user_profile (id),
  approved_at timestamptz,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budget_id_org_uq unique (id, org_id),
  constraint budget_name_uq unique (org_id, fiscal_year_id, name, version),
  constraint budget_year_fk foreign key (fiscal_year_id, org_id)
    references public.fiscal_year (id, org_id) on delete restrict
);
alter table public.budget enable row level security;
create policy budget_all on public.budget
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.budget to app_user;
grant update (status, approved_by, approved_at, updated_at) on public.budget to app_user;

create table public.budget_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  budget_id uuid not null,
  account_id uuid not null,
  period_no integer check (period_no is null or period_no between 1 and 13),
  amount_minor bigint not null,
  job_id uuid,
  department_id uuid,
  cost_centre_id uuid,
  note text check (note is null or length(note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budget_line_id_org_uq unique (id, org_id),
  constraint budget_line_budget_fk foreign key (budget_id, org_id)
    references public.budget (id, org_id) on delete restrict,
  constraint budget_line_account_fk foreign key (account_id, org_id)
    references public.gl_account (id, org_id) on delete restrict,
  constraint budget_line_job_fk foreign key (job_id, org_id)
    references public.job (id, org_id) on delete restrict,
  constraint budget_line_department_fk foreign key (department_id, org_id)
    references public.department (id, org_id) on delete restrict,
  constraint budget_line_cc_fk foreign key (cost_centre_id, org_id)
    references public.cost_centre (id, org_id) on delete restrict
);
create index budget_line_budget_idx on public.budget_line (org_id, budget_id);
alter table public.budget_line enable row level security;
create policy budget_line_all on public.budget_line
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert, update on public.budget_line to app_user;

/* Lines freeze once the budget leaves draft. */
create or replace function app.budget_line_frozen()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  if current_setting('session_replication_role', true) = 'replica' then
    return coalesce(new, old);
  end if;
  select status into v_status from public.budget
  where id = coalesce(new.budget_id, old.budget_id)
    and org_id = coalesce(new.org_id, old.org_id);
  if v_status is distinct from 'draft' then
    raise exception 'lines of a % budget cannot change', v_status
      using errcode = 'restrict_violation';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger budget_line_frozen
  before insert or update or delete on public.budget_line
  for each row execute function app.budget_line_frozen();

-- ── tax engine ───────────────────────────────────────────────────────────────
create table public.tax_code (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  code text not null check (length(code) between 1 and 30),
  name_en text not null check (length(trim(name_en)) between 1 and 120),
  name_ar text check (name_ar is null or length(name_ar) <= 120),
  jurisdiction text not null default 'custom' check (length(jurisdiction) <= 10),
  pack_version text check (pack_version is null or length(pack_version) <= 30),
  tax_type text not null default 'vat'
    check (tax_type in ('vat', 'excise', 'withholding', 'custom')),
  treatment text not null check (treatment in
    ('standard', 'zero_rated', 'exempt', 'out_of_scope', 'reverse_charge')),
  rate_percent numeric(6, 3) not null default 0 check (rate_percent >= 0 and rate_percent <= 100),
  calculation text not null default 'exclusive' check (calculation in ('exclusive', 'inclusive')),
  recoverable boolean not null default true,
  reporting_box text check (reporting_box is null or length(reporting_box) <= 10),
  effective_from date not null,
  effective_to date,
  -- Custom org taxes exist but are NEVER labelled government-compliant.
  is_custom boolean not null default true,
  active boolean not null default true,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_code_id_org_uq unique (id, org_id),
  constraint tax_code_uq unique (org_id, code, effective_from),
  constraint tax_code_span_ck check (effective_to is null or effective_to >= effective_from)
);
alter table public.tax_code enable row level security;
create policy tax_code_all on public.tax_code
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.tax_code to app_user;
grant update (name_en, name_ar, effective_to, active, updated_at) on public.tax_code to app_user;
-- Rates/treatments are IDENTITY once created: a change is a NEW effective-dated
-- code row, never an edit (absent from the grant).

create table public.tax_entry (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  journal_entry_id uuid not null,
  source_type text not null,
  source_id uuid not null,
  tax_code_id uuid not null,
  direction text not null check (direction in ('output', 'input')),
  base_minor bigint not null,
  tax_minor bigint not null,
  txn_date date not null,
  reporting_box text,
  emirate text check (emirate is null or emirate in
    ('AUH', 'DXB', 'SHJ', 'AJM', 'UAQ', 'RAK', 'FUJ')),
  code_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  constraint tax_entry_id_org_uq unique (id, org_id),
  constraint tax_entry_je_fk foreign key (journal_entry_id, org_id)
    references public.journal_entry (id, org_id) on delete restrict,
  constraint tax_entry_code_fk foreign key (tax_code_id, org_id)
    references public.tax_code (id, org_id) on delete restrict,
  -- One tax fact per source/direction/code (idempotent with its journal).
  constraint tax_entry_source_uq unique (org_id, source_type, source_id, direction, tax_code_id)
);
create index tax_entry_period_idx on public.tax_entry (org_id, txn_date, direction);
alter table public.tax_entry enable row level security;
create policy tax_entry_all on public.tax_entry
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.tax_entry to app_user;
create trigger tax_entry_frozen
  before update or delete on public.tax_entry
  for each row execute function app.employment_history_is_append_only();

create table public.tax_return (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,
  tax_type text not null check (tax_type in ('vat', 'corporate')),
  period_start date not null,
  period_end date not null,
  pack_version text not null,
  status text not null default 'draft'
    check (status in ('draft', 'under_review', 'locked', 'amended')),
  -- The complete computed working data: boxes, totals, exceptions,
  -- reconciliation — everything the reviewer saw.
  working jsonb not null default '{}',
  prepared_by uuid not null references public.user_profile (id),
  prepared_at timestamptz not null default now(),
  reviewed_by uuid references public.user_profile (id),
  reviewed_at timestamptz,
  locked_at timestamptz,
  amends_return_id uuid,
  notes text check (notes is null or length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tax_return_id_org_uq unique (id, org_id),
  constraint tax_return_ref_uq unique (org_id, reference),
  constraint tax_return_amends_fk foreign key (amends_return_id, org_id)
    references public.tax_return (id, org_id) on delete restrict,
  constraint tax_return_span_ck check (period_end >= period_start)
);
alter table public.tax_return enable row level security;
create policy tax_return_all on public.tax_return
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.tax_return to app_user;
grant update (status, working, reviewed_by, reviewed_at, locked_at, notes, amends_return_id, updated_at)
  on public.tax_return to app_user;

/* A locked return is history; amendment supersedes it with a NEW return. */
create or replace function app.tax_return_guard()
returns trigger
language plpgsql
as $$
begin
  if current_setting('session_replication_role', true) = 'replica' then
    return new;
  end if;
  if old.status = 'locked' then
    if not (new.status = 'amended'
            and new.working::text = old.working::text
            and new.locked_at is not distinct from old.locked_at) then
      raise exception 'a locked return is immutable; correct by an amending return'
        using errcode = 'restrict_violation';
    end if;
  end if;
  if old.status = 'amended' then
    raise exception 'an amended return is history' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger tax_return_guard
  before update on public.tax_return
  for each row execute function app.tax_return_guard();
create trigger tax_return_no_delete
  before delete on public.tax_return
  for each row execute function app.employment_history_is_append_only();

create table public.ct_adjustment (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  return_id uuid not null,
  rule_key text not null check (length(rule_key) <= 60),
  label text not null check (length(trim(label)) between 1 and 200),
  direction text not null check (direction in ('add', 'deduct')),
  source_amount_minor bigint not null,
  adjustment_minor bigint not null check (adjustment_minor >= 0),
  legal_source text not null check (length(legal_source) <= 300),
  calculation text not null check (length(calculation) <= 500),
  evidence text check (evidence is null or length(evidence) <= 1000),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  void_reason text check (void_reason is null or length(void_reason) <= 300),
  constraint ct_adjustment_id_org_uq unique (id, org_id),
  constraint ct_adjustment_return_fk foreign key (return_id, org_id)
    references public.tax_return (id, org_id) on delete restrict,
  constraint ct_adjustment_void_ck check (voided_at is null or void_reason is not null)
);
create index ct_adjustment_return_idx on public.ct_adjustment (org_id, return_id)
  where voided_at is null;
alter table public.ct_adjustment enable row level security;
create policy ct_adjustment_all on public.ct_adjustment
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.ct_adjustment to app_user;
grant update (voided_at, void_reason) on public.ct_adjustment to app_user;
