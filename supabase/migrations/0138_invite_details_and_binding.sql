-- 0138 — invitations a person can understand and only the invited person can take.
--
-- WHY (owner, 2026-09-20, fresh company): the invitation page showed "You have
-- been invited" for any string, said nothing about which company or role, and
-- every failure — expired, revoked, already a member, out of seats — read
-- "invalid or expired". The accept path also bound the invite to nobody: any
-- signed-in account holding the link joined the workspace.
--
-- WHAT:
--   1. app.peek_invite_details — a read-only DEFINER peek by token hash that
--      returns the company, role, invited address, expiry and STATE
--      (pending / accepted / revoked / expired), for the landing page and the
--      accept path. Zero rows = unknown token. Never consumes the invite.
--   2. app.accept_invite — same body as 0007 plus one rule: when the invite
--      names an email address, the accepting user's address must match it
--      (case-insensitive). Phone invites (email null) are unchanged.
--
-- Rollback note: drop function app.peek_invite_details(text); re-create
-- app.accept_invite from 0007_phase_d_hardening.sql. Forward-only otherwise.

create or replace function app.peek_invite_details(p_token_hash text)
returns table(
  org_id uuid,
  org_name text,
  role_key text,
  archetype text,
  email text,
  expires_at timestamptz,
  state text
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.org_id,
         o.name,
         i.role_key,
         r.archetype,
         i.email,
         i.expires_at,
         case
           when i.accepted_at is not null then 'accepted'
           when i.revoked_at is not null then 'revoked'
           when i.expires_at <= now() then 'expired'
           else 'pending'
         end as state
  from public.membership_invite i
  join public.org o on o.id = i.org_id
  join public.role_definition r on r.org_id = i.org_id and r.key = i.role_key
  where i.token_hash = p_token_hash;
$$;

revoke all on function app.peek_invite_details(text) from public;
grant execute on function app.peek_invite_details(text) to app_user;

create or replace function app.accept_invite(p_token_hash text, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite record;
  v_session_user uuid;
  v_membership_id uuid;
  v_user_email text;
begin
  v_session_user := nullif(current_setting('app.user_id', true), '')::uuid;
  if v_session_user is null or v_session_user <> p_user_id then
    raise exception 'user mismatch: invite must be accepted by the session user';
  end if;
  if not exists (select 1 from public.user_profile where id = p_user_id) then
    raise exception 'unknown user';
  end if;

  select * into v_invite
  from public.membership_invite
  where token_hash = p_token_hash
    and accepted_at is null and revoked_at is null and expires_at > now()
  for update;

  if not found then
    raise exception 'invite invalid or expired';
  end if;

  -- 0138: an emailed invitation belongs to the address it was sent to.
  if v_invite.email is not null then
    select lower(u.email) into v_user_email from auth.users u where u.id = p_user_id;
    if v_user_email is distinct from lower(v_invite.email) then
      raise exception 'invite account mismatch';
    end if;
  end if;

  if exists (select 1 from public.membership
             where user_id = p_user_id and org_id = v_invite.org_id) then
    raise exception 'already a member';
  end if;

  insert into public.membership (user_id, org_id, role_key, invited_by, invited_at, invite_channel)
  values (p_user_id, v_invite.org_id, v_invite.role_key, v_invite.invited_by,
          v_invite.created_at, case when v_invite.phone is not null then 'phone' else 'email' end)
  returning id into v_membership_id;

  update public.membership_invite
  set accepted_at = now(), accepted_by = p_user_id
  where id = v_invite.id;

  insert into public.audit_log (org_id, actor_user_id, action, entity_type, entity_id, summary)
  values (v_invite.org_id, p_user_id, 'membership.join', 'membership', v_membership_id,
          'Joined the workspace via invitation');

  return v_invite.org_id;
end
$$;
