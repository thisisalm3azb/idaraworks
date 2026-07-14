-- 0053_s9_subscription_events (S9 part 2): the provider webhook INBOX + the SECURITY DEFINER
-- platform write-path that is the SOLE writer of subscription state. v1 §13 law: subscription
-- transitions are "driven by provider webhooks, never by client claims" — so org_plan_state has
-- NO tenant write grant (0005), and every lifecycle write goes through these platform functions,
-- callable ONLY from a no-tenant-context connection (app.assert_platform_task) — the webhook
-- route and the lifecycle/reconciliation workers. A tenant request can never reach them.
-- Forward-only.

-- ── subscription_event: append-only webhook inbox (idempotency + audit of provider signals) ────
create table public.subscription_event (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('fake','stripe','paddle','lemonsqueezy','tap','moyasar')),
  -- The provider's own event id — the idempotency key (first delivery wins; replays are no-ops).
  provider_event_id text not null check (length(provider_event_id) between 1 and 200),
  org_id uuid references public.org (id) on delete restrict, -- resolved from the customer id (nullable if unresolved)
  event_type text not null check (length(event_type) between 1 and 80),
  payload jsonb not null default '{}'::jsonb,
  -- Did the inbound signature verify? A false here must never drive a state change.
  signature_verified boolean not null default false,
  status text not null default 'received'
    check (status in ('received','processed','ignored','failed','unverified')),
  error text check (error is null or length(error) <= 500),
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
-- ONE row per (provider, event id): the DB-level idempotency guard against duplicate delivery.
create unique index subscription_event_provider_event_uq
  on public.subscription_event (provider, provider_event_id);
create index subscription_event_org_idx on public.subscription_event (org_id, received_at);
create index subscription_event_unprocessed_idx
  on public.subscription_event (received_at) where processed_at is null;
alter table public.subscription_event enable row level security;
-- Platform-only (raw provider payloads): no tenant policy, no grant — reached only via the
-- DEFINER functions below (mirrors domain_event). The tenant sees subscription changes through
-- its own AUDIT log (written by the app-layer command path), never this raw inbox.

-- ── record_subscription_event: idempotent inbox insert (first-wins on the provider event id) ────
-- Returns 'new' when this is the first delivery, 'duplicate' when a row already exists.
create or replace function app.record_subscription_event(
  p_provider text,
  p_event_id text,
  p_org uuid,
  p_type text,
  p_payload jsonb,
  p_signature_verified boolean
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted boolean;
begin
  perform app.assert_platform_task();
  insert into public.subscription_event
    (provider, provider_event_id, org_id, event_type, payload, signature_verified,
     status)
  values (p_provider, p_event_id, p_org, p_type, p_payload, p_signature_verified,
     case when p_signature_verified then 'received' else 'unverified' end)
  on conflict (provider, provider_event_id) do nothing;
  get diagnostics v_inserted = row_count;
  return case when v_inserted then 'new' else 'duplicate' end;
end
$$;
revoke all on function app.record_subscription_event(text, text, uuid, text, jsonb, boolean) from public;
grant execute on function app.record_subscription_event(text, text, uuid, text, jsonb, boolean) to app_user;

-- ── advance_subscription: THE sole writer of the org_plan_state lifecycle ───────────────────────
-- The app-layer state machine (TS) validates transition LEGALITY + computes the target, then calls
-- this to persist atomically. DB-enforced invariants: platform-task-only; 'purged' is TERMINAL
-- (never transitions out); a no-op (same state, same plan) still safely refreshes the linkage.
-- NULL scalar params mean "leave unchanged" (COALESCE), except billing_state which is required.
create or replace function app.advance_subscription(
  p_org uuid,
  p_new_state text,
  p_plan_key text default null,
  p_provider text default null,
  p_provider_customer_id text default null,
  p_provider_subscription_id text default null,
  p_billing_interval text default null,
  p_billing_currency char(3) default null,
  p_period_start timestamptz default null,
  p_period_end timestamptz default null,
  p_trial_end timestamptz default null,
  p_grace_until timestamptz default null,
  p_suspend_at timestamptz default null,
  p_purge_at timestamptz default null,
  p_cancel_at_period_end boolean default null,
  p_scheduled_plan_key text default null
)
returns table (old_state text, new_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old text;
begin
  perform app.assert_platform_task();
  select billing_state into v_old from public.org_plan_state where org_id = p_org for update;
  if v_old is null then
    raise exception 'advance_subscription: org % has no plan state', p_org;
  end if;
  if v_old = 'purged' then
    raise exception 'advance_subscription: % is purged (terminal), cannot transition', p_org;
  end if;
  update public.org_plan_state set
    billing_state = p_new_state,
    plan_key = coalesce(p_plan_key, plan_key),
    provider = coalesce(p_provider, provider),
    provider_customer_id = coalesce(p_provider_customer_id, provider_customer_id),
    provider_subscription_id = coalesce(p_provider_subscription_id, provider_subscription_id),
    billing_interval = coalesce(p_billing_interval, billing_interval),
    billing_currency = coalesce(p_billing_currency, billing_currency),
    period_start = coalesce(p_period_start, period_start),
    period_end = coalesce(p_period_end, period_end),
    trial_end = coalesce(p_trial_end, trial_end),
    grace_until = coalesce(p_grace_until, grace_until),
    suspend_at = coalesce(p_suspend_at, suspend_at),
    purge_at = coalesce(p_purge_at, purge_at),
    cancel_at_period_end = coalesce(p_cancel_at_period_end, cancel_at_period_end),
    -- scheduled_plan_key: pass the sentinel '' to CLEAR it (a downgrade applied), else set/keep.
    scheduled_plan_key = case when p_scheduled_plan_key = '' then null
                              else coalesce(p_scheduled_plan_key, scheduled_plan_key) end,
    updated_at = now()
  where org_id = p_org;
  return query select v_old, p_new_state;
end
$$;
revoke all on function app.advance_subscription(uuid, text, text, text, text, text, text, char, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, boolean, text) from public;
grant execute on function app.advance_subscription(uuid, text, text, text, text, text, text, char, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, boolean, text) to app_user;

-- ── mark_subscription_event_processed: close the loop after the transition applies ─────────────
create or replace function app.mark_subscription_event_processed(
  p_provider text, p_event_id text, p_status text, p_error text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  update public.subscription_event
    set status = p_status, error = p_error, processed_at = now()
    where provider = p_provider and provider_event_id = p_event_id;
end
$$;
revoke all on function app.mark_subscription_event_processed(text, text, text, text) from public;
grant execute on function app.mark_subscription_event_processed(text, text, text, text) to app_user;
