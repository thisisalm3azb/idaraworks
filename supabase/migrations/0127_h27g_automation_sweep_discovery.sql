-- H27G — platform sweep discovery for the daily CRM automation worker:
-- which organisations have at least one ENABLED, non-dry-run automation,
-- and an owner to attribute the sweep to. Dedicated-client only
-- (app.assert_platform_task), mirroring app.orgs_with_due_documents (0119).
-- Additive only; no data change.

create or replace function app.orgs_with_crm_automations()
returns table (org_id uuid, actor_user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  return query
    with live as (
      select a.org_id
      from public.crm_automation a
      where a.enabled = true and a.dry_run = false
      group by a.org_id
    )
    select live.org_id,
           (
             select m.user_id
             from public.membership m
             join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
             where m.org_id = live.org_id and r.archetype = 'owner' and m.deactivated_at is null
             order by m.created_at asc
             limit 1
           ) as actor_user_id
    from live
    where exists (
      select 1 from public.membership m2
      join public.role_definition r2 on r2.org_id = m2.org_id and r2.key = m2.role_key
      where m2.org_id = live.org_id and r2.archetype = 'owner' and m2.deactivated_at is null
    );
end;
$$;
revoke all on function app.orgs_with_crm_automations() from public;
grant execute on function app.orgs_with_crm_automations() to app_user;
