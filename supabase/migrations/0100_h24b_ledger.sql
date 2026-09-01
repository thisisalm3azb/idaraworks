-- ═════════════════════════════════════════════════════════════════════════════
-- H24B — the canonical double-entry ledger.
--
-- One accounting truth (truth map D1): business documents stay canonical for
-- WHAT happened; journal entries are canonical for WHAT IT MEANS in the books,
-- posted from sources through idempotent rules. The invariants live HERE:
--   - the ONLY path to status 'posted' is app.post_journal_entry(), a
--     SECURITY DEFINER function that checks balance (both currencies), line
--     count, account/org integrity, control-account discipline and the open
--     period — the entry guard trigger refuses the transition from any other
--     path (D3, "prefer database invariants over UI-only protection");
--   - posted entries and their lines are immutable; correction is reversal
--     via app.reverse_journal_entry(), never edit or delete;
--   - one source event posts exactly once (unique index), so retries and two
--     racing users collapse to one posting;
--   - no DELETE grants (D-1.7): draft-line removal and draft cancellation go
--     through guarded definer functions.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── chart of accounts ────────────────────────────────────────────────────────
create table public.gl_account (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  code text not null check (length(code) between 1 and 20),
  name_en text not null check (length(trim(name_en)) between 1 and 120),
  name_ar text check (name_ar is null or length(name_ar) <= 120),
  parent_id uuid,
  account_type text not null check (account_type in
    ('asset', 'liability', 'equity', 'income', 'expense')),
  normal_balance text not null check (normal_balance in ('debit', 'credit')),
  -- Control accounts belong to a subledger; ordinary journals may not hit
  -- them directly — only posting rules (service passes the control context).
  is_control boolean not null default false,
  control_kind text check (control_kind is null or control_kind in
    ('ar', 'ap', 'bank', 'cash', 'inventory', 'tax', 'payroll')),
  -- System accounts the posting rules resolve by key (template-seeded).
  system_key text check (system_key is null or system_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  currency char(3),
  description text check (description is null or length(description) <= 500),
  archived_at timestamptz,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gl_account_id_org_uq unique (id, org_id),
  constraint gl_account_code_uq unique (org_id, code),
  constraint gl_account_system_key_uq unique (org_id, system_key),
  constraint gl_account_parent_fk foreign key (parent_id, org_id)
    references public.gl_account (id, org_id) on delete restrict,
  constraint gl_account_control_ck check (is_control = (control_kind is not null))
);
create index gl_account_org_idx on public.gl_account (org_id, account_type, code);
alter table public.gl_account enable row level security;
create policy gl_account_all on public.gl_account
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.gl_account to app_user;
grant update (name_en, name_ar, parent_id, description, archived_at, currency, updated_at)
  on public.gl_account to app_user;
-- code/type/normal_balance/control/system_key are IDENTITY: never editable in
-- app (absent from the grant). Renumbering an account is archive + create.

-- ── cost centres (the one dimension without an existing master) ─────────────
create table public.cost_centre (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  code text not null check (length(code) between 1 and 20),
  name_en text not null check (length(trim(name_en)) between 1 and 120),
  name_ar text check (name_ar is null or length(name_ar) <= 120),
  parent_id uuid,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cost_centre_id_org_uq unique (id, org_id),
  constraint cost_centre_code_uq unique (org_id, code),
  constraint cost_centre_parent_fk foreign key (parent_id, org_id)
    references public.cost_centre (id, org_id) on delete restrict
);
alter table public.cost_centre enable row level security;
create policy cost_centre_all on public.cost_centre
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.cost_centre to app_user;
grant update (name_en, name_ar, parent_id, active, updated_at) on public.cost_centre to app_user;

-- ── fiscal calendar ──────────────────────────────────────────────────────────
create table public.fiscal_year (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  label text not null check (length(label) between 1 and 40),
  starts_on date not null,
  ends_on date not null,
  status text not null default 'open' check (status in ('open', 'locked')),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fiscal_year_id_org_uq unique (id, org_id),
  constraint fiscal_year_span_ck check (ends_on > starts_on),
  -- Two fiscal years can never share a day (btree_gist from 0096).
  constraint fiscal_year_no_overlap exclude using gist
    (org_id with =, daterange(starts_on, ends_on, '[]') with &&)
);
alter table public.fiscal_year enable row level security;
create policy fiscal_year_all on public.fiscal_year
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.fiscal_year to app_user;
grant update (label, status, updated_at) on public.fiscal_year to app_user;

create table public.fiscal_period (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  fiscal_year_id uuid not null,
  period_no integer not null check (period_no between 1 and 13),
  starts_on date not null,
  ends_on date not null,
  status text not null default 'open'
    check (status in ('open', 'soft_closed', 'locked')),
  closed_by uuid references public.user_profile (id),
  closed_at timestamptz,
  reopened_by uuid references public.user_profile (id),
  reopened_at timestamptz,
  reopen_reason text check (reopen_reason is null or length(reopen_reason) <= 500),
  constraint fiscal_period_id_org_uq unique (id, org_id),
  constraint fiscal_period_no_uq unique (org_id, fiscal_year_id, period_no),
  constraint fiscal_period_year_fk foreign key (fiscal_year_id, org_id)
    references public.fiscal_year (id, org_id) on delete restrict,
  constraint fiscal_period_span_ck check (ends_on >= starts_on),
  constraint fiscal_period_no_overlap exclude using gist
    (org_id with =, daterange(starts_on, ends_on, '[]') with &&)
);
create index fiscal_period_org_dates_idx on public.fiscal_period (org_id, starts_on, ends_on);
alter table public.fiscal_period enable row level security;
create policy fiscal_period_all on public.fiscal_period
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.fiscal_period to app_user;
grant update (status, closed_by, closed_at, reopened_by, reopened_at, reopen_reason)
  on public.fiscal_period to app_user;

/*
 * A LOCKED period is a wall even for period metadata: only locked→soft_closed
 * via an explicit reopen (with who/when/why), never silent edits.
 */
create or replace function app.fiscal_period_guard()
returns trigger
language plpgsql
as $$
begin
  if current_setting('session_replication_role', true) = 'replica' then
    return new;
  end if;
  if old.status = 'locked' and new.status = 'locked' then
    raise exception 'a locked period cannot be edited' using errcode = 'restrict_violation';
  end if;
  if old.status = 'locked' and new.status is distinct from old.status then
    if new.status <> 'soft_closed' or new.reopen_reason is null or new.reopened_by is null then
      raise exception 'reopening a locked period requires soft_closed + reason + reopener'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger fiscal_period_guard
  before update on public.fiscal_period
  for each row execute function app.fiscal_period_guard();

-- ── the journal ──────────────────────────────────────────────────────────────
create table public.journal_entry (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  entry_no text not null,
  entry_date date not null,
  period_id uuid, -- resolved at posting; null while draft
  journal_kind text not null default 'general' check (journal_kind in
    ('general', 'sales', 'purchase', 'receipt', 'payment', 'contra', 'opening',
     'adjustment', 'accrual', 'depreciation', 'payroll', 'inventory', 'tax',
     'reversal', 'revaluation', 'closing')),
  memo text check (memo is null or length(memo) <= 1000),
  currency char(3) not null,
  base_currency char(3) not null,
  exchange_rate numeric(18, 8) not null default 1 check (exchange_rate > 0),
  rate_source text not null default 'base'
    check (rate_source in ('base', 'manual', 'rate_book')),
  status text not null default 'draft'
    check (status in ('draft', 'posted', 'reversed', 'cancelled')),
  -- Source linkage + idempotency (D2). event_key names the business event
  -- ('invoice:issued', 'pay_run:finalized', 'reversal:<entry>').
  source_type text check (source_type is null or length(source_type) <= 40),
  source_id uuid,
  event_key text check (event_key is null or length(event_key) <= 80),
  -- Posting-rule snapshot (D8): which versioned rule produced this entry.
  rule_key text check (rule_key is null or length(rule_key) <= 60),
  rule_version text check (rule_version is null or length(rule_version) <= 30),
  reverses_entry_id uuid,
  reversed_by_entry_id uuid,
  total_debit_minor bigint not null default 0 check (total_debit_minor >= 0),
  total_credit_minor bigint not null default 0 check (total_credit_minor >= 0),
  base_total_debit_minor bigint not null default 0 check (base_total_debit_minor >= 0),
  base_total_credit_minor bigint not null default 0 check (base_total_credit_minor >= 0),
  posted_by uuid references public.user_profile (id),
  posted_at timestamptz,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint journal_entry_id_org_uq unique (id, org_id),
  constraint journal_entry_no_uq unique (org_id, entry_no),
  constraint journal_entry_period_fk foreign key (period_id, org_id)
    references public.fiscal_period (id, org_id) on delete restrict,
  constraint journal_entry_reverses_fk foreign key (reverses_entry_id, org_id)
    references public.journal_entry (id, org_id) on delete restrict,
  constraint journal_entry_reversed_by_fk foreign key (reversed_by_entry_id, org_id)
    references public.journal_entry (id, org_id) on delete restrict,
  constraint journal_entry_source_ck check (
    (source_type is null) = (source_id is null)
    and (event_key is null or source_type is not null))
);
create index journal_entry_org_date_idx on public.journal_entry (org_id, entry_date, status);
create index journal_entry_source_idx on public.journal_entry (org_id, source_type, source_id);
-- ONE source event, ONE live posting (D2): drafts and cancelled attempts do
-- not consume the key; posted and reversed (history) do.
create unique index journal_entry_event_uq
  on public.journal_entry (org_id, source_type, source_id, event_key)
  where status in ('posted', 'reversed') and event_key is not null;
alter table public.journal_entry enable row level security;
create policy journal_entry_all on public.journal_entry
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.journal_entry to app_user;
-- Draft-only business edits. STATUS IS ABSENT: every transition goes through
-- the definer functions below, so the checks there can never be skipped.
grant update (entry_date, journal_kind, memo, currency, exchange_rate, rate_source, updated_at)
  on public.journal_entry to app_user;

create table public.journal_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  entry_id uuid not null,
  line_no integer not null check (line_no between 1 and 999),
  account_id uuid not null,
  description text check (description is null or length(description) <= 500),
  debit_minor bigint not null default 0 check (debit_minor >= 0),
  credit_minor bigint not null default 0 check (credit_minor >= 0),
  base_debit_minor bigint not null default 0 check (base_debit_minor >= 0),
  base_credit_minor bigint not null default 0 check (base_credit_minor >= 0),
  -- Dimensions (D11): the masters that exist, plus custom dims.
  job_id uuid,
  department_id uuid,
  employee_id uuid,
  customer_id uuid,
  supplier_id uuid,
  item_id uuid,
  cost_centre_id uuid,
  dims jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint journal_line_id_org_uq unique (id, org_id),
  constraint journal_line_entry_uq unique (org_id, entry_id, line_no),
  constraint journal_line_entry_fk foreign key (entry_id, org_id)
    references public.journal_entry (id, org_id) on delete restrict,
  -- Cross-organization accounts cannot mix: composite FK carries the org.
  constraint journal_line_account_fk foreign key (account_id, org_id)
    references public.gl_account (id, org_id) on delete restrict,
  constraint journal_line_job_fk foreign key (job_id, org_id)
    references public.job (id, org_id) on delete restrict,
  constraint journal_line_department_fk foreign key (department_id, org_id)
    references public.department (id, org_id) on delete restrict,
  constraint journal_line_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint journal_line_customer_fk foreign key (customer_id, org_id)
    references public.customer (id, org_id) on delete restrict,
  constraint journal_line_supplier_fk foreign key (supplier_id, org_id)
    references public.supplier (id, org_id) on delete restrict,
  constraint journal_line_item_fk foreign key (item_id, org_id)
    references public.item (id, org_id) on delete restrict,
  constraint journal_line_cost_centre_fk foreign key (cost_centre_id, org_id)
    references public.cost_centre (id, org_id) on delete restrict,
  -- Exactly one side, positive (D4).
  constraint journal_line_one_side_ck check (
    (debit_minor > 0 and credit_minor = 0) or (credit_minor > 0 and debit_minor = 0)),
  constraint journal_line_base_side_ck check (
    (debit_minor > 0) = (base_debit_minor > 0) and (credit_minor > 0) = (base_credit_minor > 0))
);
create index journal_line_entry_idx on public.journal_line (org_id, entry_id);
create index journal_line_account_idx on public.journal_line (org_id, account_id);
create index journal_line_job_idx on public.journal_line (org_id, job_id) where job_id is not null;
alter table public.journal_line enable row level security;
create policy journal_line_all on public.journal_line
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.journal_line to app_user;
grant update (line_no, account_id, description, debit_minor, credit_minor,
              base_debit_minor, base_credit_minor, job_id, department_id, employee_id,
              customer_id, supplier_id, item_id, cost_centre_id, dims, updated_at)
  on public.journal_line to app_user;

-- ── immutability at the database ────────────────────────────────────────────
/*
 * The entry guard: draft entries edit freely; the ONLY legal transitions are
 *   draft  → posted     (exclusively via app.post_journal_entry — the GUC)
 *   draft  → cancelled  (exclusively via app.cancel_draft_journal_entry)
 *   posted → reversed   (exclusively via app.reverse_journal_entry)
 * and a posted/reversed entry's substance never changes.
 */
create or replace function app.journal_entry_guard()
returns trigger
language plpgsql
as $$
begin
  if current_setting('session_replication_role', true) = 'replica' then
    return new;
  end if;
  if new.status is distinct from old.status then
    if current_setting('app.gl_transition', true) is distinct from old.id::text then
      raise exception 'journal status changes only through the posting functions'
        using errcode = 'restrict_violation';
    end if;
    if not ((old.status = 'draft' and new.status in ('posted', 'cancelled'))
            or (old.status = 'posted' and new.status = 'reversed')) then
      raise exception 'illegal journal transition % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;
  end if;
  if old.status in ('posted', 'reversed') then
    if new.memo is distinct from old.memo
       or new.entry_date is distinct from old.entry_date
       or new.currency is distinct from old.currency
       or new.exchange_rate is distinct from old.exchange_rate
       or new.journal_kind is distinct from old.journal_kind
       or new.period_id is distinct from old.period_id
       or new.total_debit_minor is distinct from old.total_debit_minor
       or new.total_credit_minor is distinct from old.total_credit_minor
       or new.base_total_debit_minor is distinct from old.base_total_debit_minor
       or new.base_total_credit_minor is distinct from old.base_total_credit_minor
       or new.source_type is distinct from old.source_type
       or new.source_id is distinct from old.source_id
       or new.event_key is distinct from old.event_key
       or new.entry_no is distinct from old.entry_no
       or new.posted_at is distinct from old.posted_at
       or new.posted_by is distinct from old.posted_by then
      raise exception 'a posted journal entry is immutable; correct by reversal'
        using errcode = 'restrict_violation';
    end if;
  end if;
  if old.status = 'cancelled' then
    raise exception 'a cancelled draft cannot change' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger journal_entry_guard
  before update on public.journal_entry
  for each row execute function app.journal_entry_guard();

/* An entry is BORN a draft: nothing can insert a pre-posted row and skip the
 * posting checks. (The reversal function also inserts draft, then posts.) */
create or replace function app.journal_entry_born_draft()
returns trigger
language plpgsql
as $$
begin
  if current_setting('session_replication_role', true) = 'replica' then
    return new;
  end if;
  if new.status <> 'draft' then
    raise exception 'a journal entry is created as a draft and posted through app.post_journal_entry'
      using errcode = 'check_violation';
  end if;
  if new.posted_at is not null or new.posted_by is not null or new.period_id is not null then
    raise exception 'posting metadata is written by the posting function only'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger journal_entry_born_draft
  before insert on public.journal_entry
  for each row execute function app.journal_entry_born_draft();
create trigger journal_entry_no_delete
  before delete on public.journal_entry
  for each row execute function app.employment_history_is_append_only();

/* Lines: editable only while the entry is draft; frozen forever after. */
create or replace function app.journal_line_frozen()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  if current_setting('session_replication_role', true) = 'replica' then
    return coalesce(new, old);
  end if;
  select status into v_status from public.journal_entry
  where id = coalesce(new.entry_id, old.entry_id)
    and org_id = coalesce(new.org_id, old.org_id);
  if v_status is distinct from 'draft' then
    raise exception 'lines of a % journal entry cannot change', v_status
      using errcode = 'restrict_violation';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger journal_line_frozen
  before insert or update or delete on public.journal_line
  for each row execute function app.journal_line_frozen();

-- ── the ONE posting path ─────────────────────────────────────────────────────
/*
 * SECURITY DEFINER: verifies EVERYTHING, then performs the guarded transition
 * under the app.gl_transition GUC. Serialized per entry by a row lock; the
 * event unique index makes racing posts of the same source collapse to one.
 */
create or replace function app.post_journal_entry(p_entry uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
  e record;
  v_period record;
  v_lines integer;
  v_bad integer;
  v_d bigint; v_c bigint; v_bd bigint; v_bc bigint;
  v_winner uuid;
begin
  select app.current_org_id() into v_org;
  if v_org is null then
    raise exception 'posting requires an organization context';
  end if;

  select * into e from public.journal_entry
  where id = p_entry and org_id = v_org
  for update;
  if e is null then
    raise exception 'journal entry not found';
  end if;
  if e.status <> 'draft' then
    raise exception 'only a draft can post (this entry is %)', e.status;
  end if;

  -- Balance and line discipline (D4).
  select count(*),
         coalesce(sum(debit_minor), 0), coalesce(sum(credit_minor), 0),
         coalesce(sum(base_debit_minor), 0), coalesce(sum(base_credit_minor), 0)
  into v_lines, v_d, v_c, v_bd, v_bc
  from public.journal_line
  where entry_id = p_entry and org_id = v_org;
  if v_lines < 2 then
    raise exception 'a journal entry needs at least two lines (has %)', v_lines;
  end if;
  if v_d <> v_c then
    raise exception 'unbalanced entry: debits % <> credits % (transaction currency)', v_d, v_c;
  end if;
  if v_bd <> v_bc then
    raise exception 'unbalanced entry: debits % <> credits % (base currency)', v_bd, v_bc;
  end if;
  if v_d = 0 then
    raise exception 'an entry of zero value cannot post';
  end if;

  -- Accounts must be live, and control accounts are reserved for the rules.
  select count(*) into v_bad
  from public.journal_line l
  join public.gl_account a on a.id = l.account_id and a.org_id = l.org_id
  where l.entry_id = p_entry and l.org_id = v_org
    and (a.archived_at is not null
         or (a.is_control and current_setting('app.gl_control_ok', true) is distinct from '1'));
  if v_bad > 0 then
    raise exception 'entry uses archived accounts, or control accounts outside a posting rule';
  end if;

  -- The period must exist and be open (D5).
  select * into v_period from public.fiscal_period
  where org_id = v_org and starts_on <= e.entry_date and ends_on >= e.entry_date;
  if v_period is null then
    raise exception 'no fiscal period covers % — create the fiscal year first', e.entry_date;
  end if;
  if v_period.status <> 'open' then
    raise exception 'period % is % — posting is closed', v_period.period_no, v_period.status;
  end if;

  /*
   * The one-event-one-posting race is resolved HERE, inside a PL/pgSQL
   * exception block (a sub-transaction), because the postgres.js driver
   * poisons its whole transaction on any statement error — the loser must
   * come back a WINNER'S ID, not an exception. The loser's draft is
   * cancelled so nothing dangles.
   */
  begin
    perform set_config('app.gl_transition', p_entry::text, true);
    update public.journal_entry
    set status = 'posted',
        period_id = v_period.id,
        total_debit_minor = v_d, total_credit_minor = v_c,
        base_total_debit_minor = v_bd, base_total_credit_minor = v_bc,
        posted_by = app.current_user_id(), posted_at = now(), updated_at = now()
    where id = p_entry and org_id = v_org;
    perform set_config('app.gl_transition', '', true);
  exception when unique_violation then
    perform set_config('app.gl_transition', '', true);
    select id into v_winner from public.journal_entry
    where org_id = v_org and source_type = e.source_type and source_id = e.source_id
      and event_key = e.event_key and status in ('posted', 'reversed') and id <> p_entry;
    if v_winner is null then
      raise; -- a different unique collision — surface it
    end if;
    perform set_config('app.gl_transition', p_entry::text, true);
    update public.journal_entry set status = 'cancelled', updated_at = now()
    where id = p_entry and org_id = v_org;
    perform set_config('app.gl_transition', '', true);
    return v_winner;
  end;
  return p_entry;
end;
$$;
revoke all on function app.post_journal_entry(uuid) from public;
grant execute on function app.post_journal_entry(uuid) to app_user;

/* Cancel a draft (the only way a draft disappears — as a cancelled record). */
create or replace function app.cancel_draft_journal_entry(p_entry uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
  v_status text;
begin
  select app.current_org_id() into v_org;
  select status into v_status from public.journal_entry
  where id = p_entry and org_id = v_org for update;
  if v_status is null then raise exception 'journal entry not found'; end if;
  if v_status <> 'draft' then
    raise exception 'only a draft can be cancelled (this entry is %)', v_status;
  end if;
  perform set_config('app.gl_transition', p_entry::text, true);
  update public.journal_entry set status = 'cancelled', updated_at = now()
  where id = p_entry and org_id = v_org;
  perform set_config('app.gl_transition', '', true);
end;
$$;
revoke all on function app.cancel_draft_journal_entry(uuid) from public;
grant execute on function app.cancel_draft_journal_entry(uuid) to app_user;

/* Remove one line from a DRAFT (no DELETE grants anywhere, D-1.7). */
create or replace function app.delete_draft_journal_line(p_line uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
  v_status text;
begin
  select app.current_org_id() into v_org;
  select e.status into v_status
  from public.journal_line l
  join public.journal_entry e on e.id = l.entry_id and e.org_id = l.org_id
  where l.id = p_line and l.org_id = v_org;
  if v_status is null then raise exception 'line not found'; end if;
  if v_status <> 'draft' then
    raise exception 'lines leave only while the entry is a draft';
  end if;
  delete from public.journal_line where id = p_line and org_id = v_org;
end;
$$;
revoke all on function app.delete_draft_journal_line(uuid) from public;
grant execute on function app.delete_draft_journal_line(uuid) to app_user;

/*
 * Exact reversal: a NEW posted entry mirroring every line (debit↔credit),
 * dated p_date (must fall in an OPEN period — reversing into a locked month
 * is exactly the accident this refuses), linked both ways, atomically.
 */
create or replace function app.reverse_journal_entry(
  p_entry uuid, p_date date, p_entry_no text, p_memo text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
  e record;
  v_period record;
  v_new uuid := gen_random_uuid();
begin
  select app.current_org_id() into v_org;
  if v_org is null then raise exception 'reversal requires an organization context'; end if;

  select * into e from public.journal_entry
  where id = p_entry and org_id = v_org for update;
  if e is null then raise exception 'journal entry not found'; end if;
  if e.status <> 'posted' then
    raise exception 'only a posted entry can be reversed (this entry is %)', e.status;
  end if;

  select * into v_period from public.fiscal_period
  where org_id = v_org and starts_on <= p_date and ends_on >= p_date;
  if v_period is null or v_period.status <> 'open' then
    raise exception 'the reversal date % is not in an open period', p_date;
  end if;

  insert into public.journal_entry
    (id, org_id, entry_no, entry_date, journal_kind, memo, currency,
     base_currency, exchange_rate, rate_source, status, source_type, source_id,
     event_key, rule_key, rule_version, reverses_entry_id,
     total_debit_minor, total_credit_minor, base_total_debit_minor, base_total_credit_minor,
     created_by)
  values
    (v_new, v_org, p_entry_no, p_date, 'reversal', p_memo, e.currency,
     e.base_currency, e.exchange_rate, e.rate_source, 'draft',
     coalesce(e.source_type, 'journal_entry'), coalesce(e.source_id, e.id),
     'reversal:' || e.id, e.rule_key, e.rule_version, p_entry,
     e.total_debit_minor, e.total_credit_minor,
     e.base_total_debit_minor, e.base_total_credit_minor,
     app.current_user_id());

  insert into public.journal_line
    (org_id, entry_id, line_no, account_id, description,
     debit_minor, credit_minor, base_debit_minor, base_credit_minor,
     job_id, department_id, employee_id, customer_id, supplier_id, item_id,
     cost_centre_id, dims)
  select org_id, v_new, line_no, account_id, description,
         credit_minor, debit_minor, base_credit_minor, base_debit_minor,
         job_id, department_id, employee_id, customer_id, supplier_id, item_id,
         cost_centre_id, dims
  from public.journal_line
  where entry_id = p_entry and org_id = v_org;

  -- Post the mirror and mark the original, both under the transition GUC.
  perform set_config('app.gl_transition', v_new::text, true);
  update public.journal_entry
  set status = 'posted', period_id = v_period.id,
      posted_by = app.current_user_id(), posted_at = now(), updated_at = now()
  where id = v_new and org_id = v_org;
  perform set_config('app.gl_transition', p_entry::text, true);
  update public.journal_entry
  set status = 'reversed', reversed_by_entry_id = v_new, updated_at = now()
  where id = p_entry and org_id = v_org;
  perform set_config('app.gl_transition', '', true);
  return v_new;
end;
$$;
revoke all on function app.reverse_journal_entry(uuid, date, text, text) from public;
grant execute on function app.reverse_journal_entry(uuid, date, text, text) to app_user;
