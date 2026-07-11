-- 0007_phase_d_hardening
-- Phase D independent-review hardening. 0005/0006 already hosted-applied →
-- forward-only new migration. All statements idempotent-safe.
-- Rollback note: re-create the 0005/0006 forms; non-destructive.

-- ── FIX (refuted-material, defensive): the resolver is fail-loud on a missing
-- plan state, and create_org_with_owner assigns one for NEW orgs — but any org
-- created before 0005 would have none. Backfill so the invariant holds for all.
insert into public.org_plan_state (org_id, plan_key, billing_state)
select o.id, 'growth', 'trialing' from public.org o
on conflict (org_id) do nothing;

-- ── FIX (database review): plan_entitlement shape guard — a row is a feature
-- (enabled set) XOR a limit (limit_value may be null=unlimited); never both.
alter table public.plan_entitlement
  add constraint plan_entitlement_shape_ck
  check (not (enabled is not null and limit_value is not null));

-- ── FIX (database review): per-entity audit-history reads order by created_at.
drop index if exists public.audit_log_entity_idx;
create index audit_log_entity_idx on public.audit_log (org_id, entity_type, entity_id, created_at);

-- ── FIX (architecture + security review): append-only defense-in-depth + role
-- -gated reads. Replace the single `for all` policy (which relied ONLY on the
-- missing UPDATE/DELETE grant) with explicit SELECT + INSERT policies and no
-- policy covering UPDATE/DELETE — so even a stray future grant cannot attach a
-- permissive mutate policy. audit_log is the compliance stream: reads gated to
-- privileged archetypes (owner/admin/accounts); any member may write their own
-- (actor-bound) row.
drop policy audit_log_access on public.audit_log;
create policy audit_log_select on public.audit_log
  for select to app_user
  using (
    org_id = (select app.current_org_id())
    and exists (
      select 1 from public.membership m
      join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
      where m.org_id = (select app.current_org_id())
        and m.user_id = (select app.current_user_id())
        and m.deactivated_at is null
        and r.archetype in ('owner', 'admin', 'accounts')
    )
  );
create policy audit_log_insert on public.audit_log
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and actor_user_id = (select app.current_user_id())
  );

-- activity is the tenant-visible operational narrative: reads member-wide,
-- writes actor-bound; still append-only (no update/delete policy).
drop policy activity_access on public.activity;
create policy activity_select on public.activity
  for select to app_user
  using (org_id = (select app.current_org_id()));
create policy activity_insert on public.activity
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and actor_user_id = (select app.current_user_id())
  );

-- ── FIX (architecture review): make the org.create / membership.join audit
-- rows ATOMIC with their mutation by writing them INSIDE the SECURITY DEFINER
-- bootstrap functions (owner context), removing the best-effort TS follow-up.
-- Both are 4th revisions via CREATE OR REPLACE; all prior guards preserved.
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

  insert into public.org_plan_state (org_id, plan_key, billing_state)
  values (v_org_id, 'growth', 'trialing');

  -- Atomic audit (owner context): org creation is now recorded in the same
  -- transaction as the mutation it describes.
  insert into public.audit_log (org_id, actor_user_id, action, entity_type, entity_id, summary)
  values (v_org_id, p_user_id, 'org.create', 'org', v_org_id, 'Created workspace ' || p_name);

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
  v_membership_id uuid;
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

revoke all on function app.accept_invite(text, uuid) from public;
grant execute on function app.accept_invite(text, uuid) to app_user;
