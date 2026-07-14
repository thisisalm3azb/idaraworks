-- 0062_s10_definer_meter_guards (S10 security hardening — tenancy-rls + concurrency lenses):
-- close two latent tenancy gaps the S10 audit confirmed. Forward-only.

-- ── (1) Guard the 0058 cross-org scans behind the platform-task boundary ────────────────────────
-- app.lifecycle_scan() and app.subscription_recon_scan() are SECURITY DEFINER (bypass RLS),
-- EXECUTE-granted to app_user, return EVERY org's plan/state with no org filter — and had NO
-- platform-task guard (0058 punted, noting SQL functions cannot PERFORM). A SQL body indeed cannot,
-- so re-author both as plpgsql that PERFORMs app.assert_platform_task() first: a session carrying an
-- org OR user GUC (every tenant request) is rejected before any row is read. Matches 0036/0039/0053.
create or replace function app.lifecycle_scan()
returns table (
  org_id uuid, billing_state text, period_start timestamptz, trial_end timestamptz,
  grace_until timestamptz, suspend_at timestamptz, purge_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  return query
    select s.org_id, s.billing_state, s.period_start, s.trial_end, s.grace_until, s.suspend_at, s.purge_at
    from public.org_plan_state s
    where s.billing_state in ('trialing','past_due','grace','suspended','cancelled','purge_pending');
end
$$;
revoke all on function app.lifecycle_scan() from public;
grant execute on function app.lifecycle_scan() to app_user;

create or replace function app.subscription_recon_scan()
returns table (
  org_id uuid, billing_state text, plan_key text, provider text,
  provider_customer_id text, provider_subscription_id text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  return query
    select s.org_id, s.billing_state, s.plan_key, s.provider, s.provider_customer_id, s.provider_subscription_id
    from public.org_plan_state s
    where s.provider is not null and s.provider <> 'none';
end
$$;
revoke all on function app.subscription_recon_scan() from public;
grant execute on function app.subscription_recon_scan() to app_user;

-- ── (2) usage_event: tenants may only ADD non-negative deltas ───────────────────────────────────
-- The meter's value is sum(delta). Corrections are negative rows, but those are a PLATFORM writer's
-- job (a DEFINER path bypasses RLS). The tenant INSERT policy accepted arbitrary deltas, so a tenant
-- could self-insert negative rows to deflate its own meter and slip past a metered ADD limit. Pin the
-- tenant policy to delta >= 0; a future negative-correction path is platform-written, not tenant.
drop policy if exists usage_event_insert on public.usage_event;
create policy usage_event_insert on public.usage_event
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and delta >= 0);
