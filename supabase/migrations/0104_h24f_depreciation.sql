-- ═════════════════════════════════════════════════════════════════════════════
-- H24F — asset depreciation runs.
--
-- The H22E asset register already carries cost, residual value, useful life
-- and a depreciation start date. A run computes straight-line depreciation
-- for one period across the register, keeps per-asset lines, and posts ONE
-- journal entry. Runs are immutable once posted (they ARE the subledger the
-- accumulated-depreciation account reconciles against).
-- ═════════════════════════════════════════════════════════════════════════════

create table public.asset_depreciation_run (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,
  period_start date not null,
  period_end date not null,
  method text not null default 'straight_line' check (method in ('straight_line')),
  status text not null default 'posted' check (status in ('posted', 'reversed')),
  total_minor bigint not null check (total_minor >= 0),
  journal_entry_id uuid,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint asset_depreciation_run_id_org_uq unique (id, org_id),
  constraint asset_depreciation_run_ref_uq unique (org_id, reference),
  -- One run per period span (idempotency at the schedule level).
  constraint asset_depreciation_run_period_uq unique (org_id, period_start, period_end),
  constraint asset_depreciation_run_je_fk foreign key (journal_entry_id, org_id)
    references public.journal_entry (id, org_id) on delete restrict
);
alter table public.asset_depreciation_run enable row level security;
create policy asset_depreciation_run_all on public.asset_depreciation_run
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.asset_depreciation_run to app_user;
grant update (status, total_minor, journal_entry_id) on public.asset_depreciation_run to app_user;

create table public.asset_depreciation_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  run_id uuid not null,
  asset_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  accumulated_after_minor bigint not null check (accumulated_after_minor >= 0),
  created_at timestamptz not null default now(),
  constraint asset_depreciation_line_id_org_uq unique (id, org_id),
  constraint asset_depreciation_line_uq unique (org_id, run_id, asset_id),
  constraint asset_depreciation_line_run_fk foreign key (run_id, org_id)
    references public.asset_depreciation_run (id, org_id) on delete restrict,
  constraint asset_depreciation_line_asset_fk foreign key (asset_id, org_id)
    references public.asset (id, org_id) on delete restrict
);
create index asset_depreciation_line_asset_idx
  on public.asset_depreciation_line (org_id, asset_id);
alter table public.asset_depreciation_line enable row level security;
create policy asset_depreciation_line_all on public.asset_depreciation_line
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.asset_depreciation_line to app_user;

/* Runs and lines are append-only history (correction = reversal run). */
create trigger asset_depreciation_run_no_delete
  before delete on public.asset_depreciation_run
  for each row execute function app.employment_history_is_append_only();
create trigger asset_depreciation_line_frozen
  before update or delete on public.asset_depreciation_line
  for each row execute function app.employment_history_is_append_only();
