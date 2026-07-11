-- 0004_identity_hardening
-- Phase C independent-review fixes. 0003 is already applied on hosted, so
-- forward-only discipline (BUILD_BIBLE §4.14) requires a NEW migration rather
-- than editing 0003. All statements here are idempotent-safe replacements.
-- Rollback note: re-create the 0003 forms; non-destructive to data.

-- ── FIX (material, database review): deactivated members vanished from rosters.
-- The co-member visibility clause required the TARGET's membership to be active,
-- so listMembers' inner join dropped every deactivated member — contradicting
-- D-1.7 (deactivate keeps history visible, unlike delete). Only ACTIVE members
-- obtain an org ctx (resolveCtx enforces that on the viewer), so showing a
-- deactivated member's profile to active co-members grants the deactivated user
-- nothing. Drop the target-side deactivated_at filter.
drop policy user_profile_access on public.user_profile;
create policy user_profile_access on public.user_profile
  for all to app_user
  using (
    id = (select app.current_user_id())
    or exists (
      select 1 from public.membership m
      where m.user_id = user_profile.id
        and m.org_id = (select app.current_org_id())
    )
  )
  with check (id = (select app.current_user_id()));

-- ── FIX (security review): sign_in_log user_id forgery via the null disjunct.
-- `or current_user_id() is null` let the anonymous (no-GUC) path insert a row
-- naming ANY victim's user_id. The genuine anonymous path writes user_id = null,
-- which still passes on the first disjunct — so the third is pure hole. Remove it.
drop policy sign_in_log_access on public.sign_in_log;
create policy sign_in_log_access on public.sign_in_log
  for all to app_user
  using (
    user_id = (select app.current_user_id())
    or (org_id is not null and org_id = (select app.current_org_id()))
  )
  with check (
    (org_id is null or org_id = (select app.current_org_id()))
    and (user_id is null or user_id = (select app.current_user_id()))
  );

-- ── FIX (security review): intra-org privilege escalation via direct UPDATE.
-- 0003 granted column-unrestricted UPDATE on membership; RLS with_check validates
-- only org_id, so the DB backstop alone would let a member rewrite role_key
-- (self → owner) or org_id. Narrow the grant to the only columns the app updates
-- (deactivation). role_key/user_id/org_id become unwritable by app_user entirely;
-- role changes will arrive via a SECURITY DEFINER path in the config slice.
revoke update on public.membership from app_user;
grant update (deactivated_at, updated_at) on public.membership to app_user;

-- ── FIX (security review): SECURITY DEFINER functions trusted caller-supplied
-- p_user_id (impersonation if ever mis-called). Bind the acting user to the
-- session GUC. Also uppercase p_country ONCE (database review: working_week was
-- computed from the raw arg while org.country stored the uppercased form, so a
-- lowercase caller arg produced an inconsistent working week).
create or replace function app.create_org_with_owner(
  p_user_id uuid,
  p_name text,
  p_country char(2),
  p_base_currency char(3),
  p_timezone text,
  p_languages text[],
  p_six_day_week boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_working_week jsonb;
  v_country char(2);
  v_session_user uuid;
begin
  v_session_user := nullif(current_setting('app.user_id', true), '')::uuid;
  if v_session_user is null or v_session_user <> p_user_id then
    raise exception 'user mismatch: org creation must act as the session user';
  end if;
  if not exists (select 1 from public.user_profile where id = p_user_id) then
    raise exception 'unknown user';
  end if;
  if p_name is null or length(trim(p_name)) < 2 or length(p_name) > 120 then
    raise exception 'invalid org name';
  end if;

  v_country := upper(p_country);
  v_working_week := case
    when v_country in ('SA','QA','KW','BH','OM') then
      case when p_six_day_week
        then '{"days":["sun","mon","tue","wed","thu","sat"]}'::jsonb
        else '{"days":["sun","mon","tue","wed","thu"]}'::jsonb end
    else
      case when p_six_day_week
        then '{"days":["mon","tue","wed","thu","fri","sat"]}'::jsonb
        else '{"days":["mon","tue","wed","thu","fri"]}'::jsonb end
  end;

  insert into public.org (name, country, timezone, base_currency, languages, working_week)
  values (p_name, v_country, coalesce(p_timezone, 'Asia/Dubai'),
          upper(p_base_currency), coalesce(p_languages, array['en']), v_working_week)
  returning id into v_org_id;

  insert into public.company (org_id, name, is_default) values (v_org_id, p_name, true);

  insert into public.role_definition (org_id, key, archetype, label, cost_privileged, price_privileged)
  values
    (v_org_id, 'owner',       'owner',       '{"en":"Owner","ar":"المالك"}',            true,  true),
    (v_org_id, 'admin',       'admin',       '{"en":"Admin","ar":"مشرف"}',              true,  true),
    (v_org_id, 'manager',     'manager',     '{"en":"Manager","ar":"مدير"}',            false, false),
    (v_org_id, 'foreman',     'foreman',     '{"en":"Foreman","ar":"مشرف ورشة"}',       false, false),
    (v_org_id, 'procurement', 'procurement', '{"en":"Procurement","ar":"مشتريات"}',     false, false),
    (v_org_id, 'accounts',    'accounts',    '{"en":"Accounts","ar":"حسابات"}',         true,  true),
    (v_org_id, 'viewer',      'viewer',      '{"en":"Viewer","ar":"مشاهد"}',            false, false);

  insert into public.membership (user_id, org_id, role_key)
  values (p_user_id, v_org_id, 'owner');

  return v_org_id;
end
$$;

revoke all on function app.create_org_with_owner(uuid, text, char, char, text, text[], boolean) from public;
grant execute on function app.create_org_with_owner(uuid, text, char, char, text, text[], boolean) to app_user;

create or replace function app.accept_invite(p_token_hash text, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite record;
  v_session_user uuid;
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
  if exists (select 1 from public.membership
             where user_id = p_user_id and org_id = v_invite.org_id) then
    raise exception 'already a member';
  end if;

  insert into public.membership (user_id, org_id, role_key, invited_by, invited_at, invite_channel)
  values (p_user_id, v_invite.org_id, v_invite.role_key, v_invite.invited_by,
          v_invite.created_at, case when v_invite.phone is not null then 'phone' else 'email' end);

  update public.membership_invite
  set accepted_at = now(), accepted_by = p_user_id
  where id = v_invite.id;

  return v_invite.org_id;
end
$$;

revoke all on function app.accept_invite(text, uuid) from public;
grant execute on function app.accept_invite(text, uuid) to app_user;
