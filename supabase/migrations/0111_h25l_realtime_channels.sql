-- 0111 — H25L: private Realtime channels for the Management Studio.
--
-- Collaboration is server-authoritative (ADR-3): every edit is a server
-- action through the permission matrix, and Realtime only carries presence
-- (who is looking, where their selection is) and a "changed" nudge that
-- makes other clients re-resolve. Channels are PRIVATE: Supabase evaluates
-- these policies on realtime.messages when a client subscribes (SELECT =
-- may receive, INSERT = may send). The topic is `studio:<org>:<plan>` and
-- only members of that organisation pass. No business data rides a message.
--
-- The membership check runs as a SECURITY DEFINER function because the
-- `authenticated` role has no grant on public.membership (app rows are read
-- through app_user with the tenancy GUCs); the function only ever answers
-- "is the calling user a member of this org", nothing more.
-- Additive: one function and two policies.

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

create policy studio_channel_receive on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and app.studio_channel_allowed(realtime.topic())
  );

create policy studio_channel_send on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and app.studio_channel_allowed(realtime.topic())
  );
