-- 0112 — H25L: the channel membership check runs as a SECURITY DEFINER.
--
-- 0111's policies subquery public.membership directly, but the policies are
-- evaluated as the `authenticated` role, which has no grant on that table
-- (app rows are read through app_user with the tenancy GUCs), so subscribing
-- to a private plan channel would fail with permission denied. This function
-- answers only "is the calling user a member of the org in this topic" and
-- the policies are recreated on top of it. Additive: one function, two
-- policies replaced in place.

create or replace function app.studio_channel_allowed(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_topic like 'studio:%'
     and split_part(p_topic, ':', 2) ~ '^[0-9a-f-]{36}$'
     and exists (
       select 1 from public.membership m
       where m.user_id = auth.uid()
         and m.org_id = split_part(p_topic, ':', 2)::uuid
     );
$$;
revoke all on function app.studio_channel_allowed(text) from public;
grant execute on function app.studio_channel_allowed(text) to authenticated;

-- Policies only where realtime.messages exists (see 0111); the predicate above
-- is always created so the application code can rely on it.
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute $p$drop policy if exists studio_channel_receive on realtime.messages$p$;
    execute $p$drop policy if exists studio_channel_send on realtime.messages$p$;
    execute $p$create policy studio_channel_receive on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and app.studio_channel_allowed(realtime.topic())
  )$p$;
    execute $p$create policy studio_channel_send on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and app.studio_channel_allowed(realtime.topic())
  )$p$;
  end if;
end $$;
