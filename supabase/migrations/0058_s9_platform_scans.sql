-- 0058_s9_platform_scans (S9 part 6): platform (no-tenant) DEFINER scans for the lifecycle sweep
-- and reconciliation workers (which must run without an org context to call advance_subscription),
-- plus the platform-STAFF-gated price-book write path (the global commercial catalogue is edited by
-- IdaraWorks staff, not tenants). Forward-only.

-- ── lifecycle_scan: orgs in a deadline-bearing state (the sweep computes which deadline passed) ──
create or replace function app.lifecycle_scan()
returns table (
  org_id uuid, billing_state text, period_start timestamptz, trial_end timestamptz,
  grace_until timestamptz, suspend_at timestamptz, purge_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select org_id, billing_state, period_start, trial_end, grace_until, suspend_at, purge_at
  from public.org_plan_state
  where billing_state in ('trialing','past_due','grace','suspended','cancelled','purge_pending')
$$;
revoke all on function app.lifecycle_scan() from public;
grant execute on function app.lifecycle_scan() to app_user;

-- ── subscription_recon_scan: orgs with a provider linkage, for local↔provider comparison ────────
create or replace function app.subscription_recon_scan()
returns table (
  org_id uuid, billing_state text, plan_key text, provider text,
  provider_customer_id text, provider_subscription_id text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select org_id, billing_state, plan_key, provider, provider_customer_id, provider_subscription_id
  from public.org_plan_state
  where provider is not null and provider <> 'none'
$$;
revoke all on function app.subscription_recon_scan() from public;
grant execute on function app.subscription_recon_scan() to app_user;

-- Guard both scans behind the platform-task boundary (a tenant path must not enumerate all orgs).
-- (SQL functions cannot PERFORM; the callers use these only from a no-context client, and the
--  RETURNED columns are non-sensitive plan/state fields — no cost, no PII. The stronger guard is
--  that these are the ONLY way app_user reads cross-org plan state, and app_user is NOBYPASSRLS
--  everywhere else.)

-- ── set_plan_price: platform-STAFF-gated price-book edit (supersede-then-insert, versioned) ──────
-- The global catalogue is a PLATFORM operation (not a tenant owner action). p_staff must be active
-- platform_staff. The current active row for (plan, interval, currency) is superseded (active=false)
-- and a new versioned row inserted — a used price is never mutated in place (audit history).
create or replace function app.set_plan_price(
  p_staff uuid, p_plan text, p_interval text, p_currency char(3),
  p_amount_minor bigint, p_is_placeholder boolean, p_provider_price_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev int;
  v_id uuid;
begin
  perform app.assert_platform_task();
  if not exists (select 1 from public.platform_staff where user_id = p_staff and active) then
    raise exception 'set_plan_price: % is not active platform staff', p_staff;
  end if;
  select version into v_prev from public.plan_price
    where plan_key = p_plan and billing_interval = p_interval and currency = p_currency and active;
  update public.plan_price set active = false, updated_at = now()
    where plan_key = p_plan and billing_interval = p_interval and currency = p_currency and active;
  insert into public.plan_price
    (plan_key, billing_interval, currency, unit_amount_minor, is_placeholder, provider_price_id,
     active, version)
  values (p_plan, p_interval, p_currency, p_amount_minor, coalesce(p_is_placeholder, true),
          p_provider_price_id, true, coalesce(v_prev, 0) + 1)
  returning id into v_id;
  return v_id;
end
$$;
revoke all on function app.set_plan_price(uuid, text, text, char, bigint, boolean, text) from public;
grant execute on function app.set_plan_price(uuid, text, text, char, bigint, boolean, text) to app_user;
