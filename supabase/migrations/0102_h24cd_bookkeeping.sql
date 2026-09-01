-- ═════════════════════════════════════════════════════════════════════════════
-- H24C/D — bookkeeping conveniences and open-item settlement.
--
-- journal_template: memorized + recurring journals. NO worker exists, so
-- recurrence is computed on read (a due list) and a human materializes a
-- draft — nothing posts itself.
--
-- settlement_allocation: ONE allocation truth for open items — a customer
-- payment across invoices, a supplier payment across received orders, an
-- advance applied later. Allocations never move money; they explain it.
-- ═════════════════════════════════════════════════════════════════════════════

create table public.journal_template (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 120),
  journal_kind text not null default 'general',
  memo text check (memo is null or length(memo) <= 1000),
  -- Lines as data: [{accountId, description, debitMinor, creditMinor, dims…}].
  -- Materialization validates against the live chart; a template is a
  -- convenience, never a posting path.
  lines jsonb not null default '[]',
  recurrence text check (recurrence is null or recurrence in ('monthly', 'quarterly', 'yearly')),
  next_run_on date,
  active boolean not null default true,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint journal_template_id_org_uq unique (id, org_id),
  constraint journal_template_name_uq unique (org_id, name),
  constraint journal_template_recurrence_ck check ((recurrence is null) = (next_run_on is null))
);
alter table public.journal_template enable row level security;
create policy journal_template_all on public.journal_template
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.journal_template to app_user;
grant update (name, journal_kind, memo, lines, recurrence, next_run_on, active, updated_at)
  on public.journal_template to app_user;

create table public.settlement_allocation (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  -- The money side: an AR payment or (H24E) a money transaction.
  payer_type text not null check (payer_type in ('payment', 'money_transaction')),
  payer_id uuid not null,
  -- The open item it settles.
  target_type text not null check (target_type in ('invoice', 'goods_receipt', 'purchase_order', 'advance')),
  target_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  base_amount_minor bigint not null check (base_amount_minor > 0),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  void_reason text check (void_reason is null or length(void_reason) <= 300),
  constraint settlement_allocation_id_org_uq unique (id, org_id),
  constraint settlement_allocation_void_ck check (voided_at is null or void_reason is not null)
);
create index settlement_allocation_payer_idx
  on public.settlement_allocation (org_id, payer_type, payer_id) where voided_at is null;
create index settlement_allocation_target_idx
  on public.settlement_allocation (org_id, target_type, target_id) where voided_at is null;
alter table public.settlement_allocation enable row level security;
create policy settlement_allocation_all on public.settlement_allocation
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.settlement_allocation to app_user;
grant update (voided_at, void_reason) on public.settlement_allocation to app_user;

-- Party finance profiles: terms and limits live on the existing masters.
alter table public.customer
  add column payment_terms_days integer check (payment_terms_days is null or payment_terms_days between 0 and 365),
  add column credit_limit_minor bigint check (credit_limit_minor is null or credit_limit_minor >= 0);
alter table public.supplier
  add column payment_terms_days integer check (payment_terms_days is null or payment_terms_days between 0 and 365),
  add column credit_limit_minor bigint check (credit_limit_minor is null or credit_limit_minor >= 0);
grant update (payment_terms_days, credit_limit_minor) on public.customer to app_user;
grant update (payment_terms_days, credit_limit_minor) on public.supplier to app_user;
