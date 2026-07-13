-- 0036_s4_stuck_approvals (S4 — the E-03 stub's cross-org sweep helper).
-- The hourly evaluator is a PLATFORM task (no tenant GUC); it needs to discover,
-- across orgs, which ones hold a stuck pending approval and a real actor to raise
-- the exception as. Same platform-task discipline as the outbox relay (0014):
-- SECURITY DEFINER + app.assert_platform_task() so ONLY a no-tenant-context caller
-- may run it. Forward-only.

create or replace function app.orgs_with_pending_approvals(p_min_age interval)
returns table (org_id uuid, actor_user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  return query
    select a.org_id,
           (
             select m.user_id
             from public.membership m
             join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
             where m.org_id = a.org_id and r.archetype = 'owner' and m.deactivated_at is null
             order by m.created_at asc
             limit 1
           ) as actor_user_id
    from public.approval a
    where a.state = 'pending' and a.created_at < now() - p_min_age
    group by a.org_id
    having exists (
      select 1 from public.membership m2
      join public.role_definition r2 on r2.org_id = m2.org_id and r2.key = m2.role_key
      where m2.org_id = a.org_id and r2.archetype = 'owner' and m2.deactivated_at is null
    );
end;
$$;
revoke all on function app.orgs_with_pending_approvals(interval) from public;
grant execute on function app.orgs_with_pending_approvals(interval) to app_user;
