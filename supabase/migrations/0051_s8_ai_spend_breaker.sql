-- 0051_s8_ai_spend_breaker (S8 review fix): the platform daily AI-spend circuit breaker
-- (doc 10 #32) must read a CROSS-ORG aggregate, but app_user is NOBYPASSRLS so an unscoped
-- `sum(cost_micros)` over public.ai_interaction is silently zeroed by RLS (org_id = NULL) —
-- the breaker was fail-open. This SECURITY DEFINER helper does the platform-wide read as its
-- owner (RLS-exempt) and returns ONLY a single aggregate number (no tenant row is exposed).
-- It is NOT app.assert_platform_task-guarded on purpose: it is called from a tenant request
-- path (onboarding) and reveals nothing tenant-specific — just today's total metered spend.
-- Forward-only.
create or replace function app.platform_daily_ai_spend()
returns bigint
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select coalesce(sum(cost_micros), 0)::bigint
  from public.ai_interaction
  where created_at >= date_trunc('day', now());
$$;
revoke all on function app.platform_daily_ai_spend() from public;
grant execute on function app.platform_daily_ai_spend() to app_user;
