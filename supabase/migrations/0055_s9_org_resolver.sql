-- 0055_s9_org_resolver (S9 fix): resolve an org from its provider customer id in a PLATFORM
-- (no-tenant) context. The webhook processor runs as app_user with no org GUC, so a plain SELECT
-- on org_plan_state is RLS-zeroed (the table is tenant-read-only, 0005) — it returned no org and
-- every lifecycle transition fell to 'unresolved'. This SECURITY DEFINER resolver does the read as
-- its owner (RLS-exempt), returns ONLY (org_id, billing_state), and is assert_platform_task-guarded
-- so a tenant request can never call it to enumerate other orgs. Forward-only.
create or replace function app.resolve_subscription_org(p_provider text, p_customer_id text)
returns table (org_id uuid, billing_state text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  return query
    select ops.org_id, ops.billing_state
    from public.org_plan_state ops
    where ops.provider = p_provider and ops.provider_customer_id = p_customer_id
    limit 1;
end
$$;
revoke all on function app.resolve_subscription_org(text, text) from public;
grant execute on function app.resolve_subscription_org(text, text) to app_user;
