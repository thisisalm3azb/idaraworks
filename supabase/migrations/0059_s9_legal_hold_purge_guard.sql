-- 0059_s9_legal_hold_purge_guard (S9): a legal hold (v1 §12) suspends ALL deletion pipelines, so
-- the DB sole-writer must refuse to advance an org to 'purged' while legal_hold is set — the purge
-- worker cannot purge a held org even by mistake. Redefines advance_subscription (same signature)
-- to add the guard; all other behaviour is preserved verbatim from 0053. Forward-only.
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
  v_hold boolean;
begin
  perform app.assert_platform_task();
  select billing_state, legal_hold into v_old, v_hold
    from public.org_plan_state where org_id = p_org for update;
  if v_old is null then
    raise exception 'advance_subscription: org % has no plan state', p_org;
  end if;
  if v_old = 'purged' then
    raise exception 'advance_subscription: % is purged (terminal), cannot transition', p_org;
  end if;
  if p_new_state = 'purged' and coalesce(v_hold, false) then
    raise exception 'advance_subscription: % is under legal hold, purge suspended', p_org;
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
    scheduled_plan_key = case when p_scheduled_plan_key = '' then null
                              else coalesce(p_scheduled_plan_key, scheduled_plan_key) end,
    updated_at = now()
  where org_id = p_org;
  return query select v_old, p_new_state;
end
$$;
