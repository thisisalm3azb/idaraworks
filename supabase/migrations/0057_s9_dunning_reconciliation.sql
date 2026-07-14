-- 0057_s9_dunning_reconciliation (S9 part 5): the dunning-attempt log + the provider/local
-- reconciliation drift log, each with a platform (no-tenant) DEFINER writer. Forward-only.

-- ── dunning_attempt: append-only log of payment-recovery reminders sent in a failed-payment cycle ─
-- Idempotent per (org, cycle, attempt_no) so a re-run of the dunning worker never double-sends.
-- Tenant-readable (transparency: "we emailed you about a failed payment"). Platform-write only.
create table public.dunning_attempt (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  cycle_key text not null check (length(cycle_key) between 1 and 40), -- the past_due entry instant
  attempt_no int not null check (attempt_no between 1 and 20),
  created_at timestamptz not null default now(),
  constraint dunning_attempt_id_org_uq unique (id, org_id)
);
create unique index dunning_attempt_idem_uq
  on public.dunning_attempt (org_id, cycle_key, attempt_no);
alter table public.dunning_attempt enable row level security;
create policy dunning_attempt_read on public.dunning_attempt
  for select to app_user using (org_id = (select app.current_org_id()));
grant select on public.dunning_attempt to app_user;

-- ── reconciliation: drift between local subscription state and provider truth (surface, don't fix) ─
-- Platform-internal (ops): no tenant policy. A finding is recorded, never auto-applied — an operator
-- reviews + resolves. resolved_at closes it.
create table public.reconciliation (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.org (id) on delete restrict, -- null for an orphan provider customer
  kind text not null check (kind in (
    'missing_provider_customer','plan_mismatch','interval_mismatch','state_divergence',
    'local_active_provider_cancelled','local_cancelled_provider_active','duplicate_subscription',
    'webhook_gap','other')),
  detail jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_note text check (resolution_note is null or length(resolution_note) <= 500)
);
create index reconciliation_open_idx on public.reconciliation (detected_at) where resolved_at is null;
create index reconciliation_org_idx on public.reconciliation (org_id, detected_at);
alter table public.reconciliation enable row level security;
-- Platform-only: reached via the DEFINER writer; no tenant grant.

-- ── record_dunning_attempt: idempotent platform insert; returns 'sent' | 'skip' ────────────────
create or replace function app.record_dunning_attempt(p_org uuid, p_cycle text, p_attempt int)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_inserted boolean;
begin
  perform app.assert_platform_task();
  insert into public.dunning_attempt (org_id, cycle_key, attempt_no)
  values (p_org, p_cycle, p_attempt)
  on conflict (org_id, cycle_key, attempt_no) do nothing;
  get diagnostics v_inserted = row_count;
  return case when v_inserted then 'sent' else 'skip' end;
end
$$;
revoke all on function app.record_dunning_attempt(uuid, text, int) from public;
grant execute on function app.record_dunning_attempt(uuid, text, int) to app_user;

-- ── record_reconciliation: idempotent-ish platform insert of an OPEN drift finding ──────────────
-- Deduped: does nothing if an unresolved finding of the same (org, kind) already exists.
create or replace function app.record_reconciliation(p_org uuid, p_kind text, p_detail jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  if exists (
    select 1 from public.reconciliation
    where kind = p_kind and resolved_at is null
      and (org_id = p_org or (org_id is null and p_org is null))
  ) then
    return 'duplicate';
  end if;
  insert into public.reconciliation (org_id, kind, detail) values (p_org, p_kind, p_detail);
  return 'recorded';
end
$$;
revoke all on function app.record_reconciliation(uuid, text, jsonb) from public;
grant execute on function app.record_reconciliation(uuid, text, jsonb) to app_user;
