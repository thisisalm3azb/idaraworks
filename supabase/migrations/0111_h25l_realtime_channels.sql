-- 0111 — H25L: private Realtime channels for the Management Studio.
--
-- Collaboration is server-authoritative (ADR-3): every edit is a server
-- action through the permission matrix, and Realtime only carries presence
-- (who is looking, where their selection is) and a "changed" nudge that
-- makes other clients re-resolve. Channels are PRIVATE: Supabase checks
-- these policies on realtime.messages when a client subscribes (SELECT =
-- may receive, INSERT = may send). The topic is `studio:<org>:<plan>` and
-- only members of that organisation pass. No business data rides a message.
--
-- Additive: policies only; nothing about existing tables changes.
-- NOTE: 0112 replaces these policies with a SECURITY DEFINER membership
-- check, because the `authenticated` role has no grant on public.membership
-- and this direct subquery fails at subscribe time. Kept as applied.

create policy studio_channel_receive on realtime.messages
  for select to authenticated
  using (
    realtime.topic() like 'studio:%'
    and realtime.messages.extension in ('broadcast', 'presence')
    and exists (
      select 1 from public.membership m
      where m.user_id = auth.uid()
        and m.org_id::text = split_part(realtime.topic(), ':', 2)
    )
  );

create policy studio_channel_send on realtime.messages
  for insert to authenticated
  with check (
    realtime.topic() like 'studio:%'
    and realtime.messages.extension in ('broadcast', 'presence')
    and exists (
      select 1 from public.membership m
      where m.user_id = auth.uid()
        and m.org_id::text = split_part(realtime.topic(), ':', 2)
    )
  );
