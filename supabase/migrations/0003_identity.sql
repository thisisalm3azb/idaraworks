-- 0003_identity (S0 checklist §3 "identity", renumbered per A-B6)
-- user_profile, role_definition, membership, membership_invite, sign_in_log,
-- the auth.users -> user_profile sync trigger, and the two SECURITY DEFINER
-- platform-bootstrap functions (org creation, invite acceptance) — the paths
-- that must exist BEFORE a tenant ctx exists (checklist note on 0001: "org
-- creation is a platform action (Phase C bootstrap path)").
-- Rollback note: drop functions/trigger, then tables in reverse; safe pre-data.

-- ── user_profile (user-level, not org-scoped; mirrors auth.users) ────────────
create table public.user_profile (
  id uuid primary key references auth.users (id) on delete restrict,
  full_name text not null default '',
  locale text not null default 'en' check (locale in ('en', 'ar')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_profile enable row level security;

-- Self-only for now; the co-member visibility clause is ADDED after membership
-- exists (Postgres validates policy expressions at creation time, so a policy
-- referencing public.membership cannot be created before that table).
create policy user_profile_access on public.user_profile
  for all to app_user
  using (id = (select app.current_user_id()))
  with check (id = (select app.current_user_id()));

grant select, update on public.user_profile to app_user;

create trigger user_profile_touch_updated_at
  before update on public.user_profile
  for each row execute function app.set_updated_at();

-- Sync trigger: every new auth user gets a profile row (standard Supabase pattern).
create or replace function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_profile (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();

-- ── role_definition (org-cloned presets; archetype ∈ registry) ───────────────
create table public.role_definition (
  org_id uuid not null references public.org (id) on delete restrict,
  key text not null,
  archetype text not null check (
    archetype in ('owner','admin','manager','foreman','procurement','accounts','viewer')
  ),
  label jsonb not null, -- {en, ar}
  cost_privileged boolean not null default false,  -- finance.viewCosts (doc 06 D-6.2)
  price_privileged boolean not null default false, -- finance.viewPrices
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, key)
);

alter table public.role_definition enable row level security;

create policy role_definition_tenant_isolation on public.role_definition
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));

grant select on public.role_definition to app_user; -- edits arrive with S1 config pipeline

create trigger role_definition_touch_updated_at
  before update on public.role_definition
  for each row execute function app.set_updated_at();

-- ── membership (user × org × role; doc 10 #22 deactivation) ──────────────────
create table public.membership (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profile (id) on delete restrict,
  org_id uuid not null references public.org (id) on delete restrict,
  role_key text not null,
  deactivated_at timestamptz,
  invited_by uuid references public.user_profile (id),
  invited_at timestamptz,
  invite_channel text check (invite_channel in ('email', 'phone')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, org_id),
  foreign key (org_id, role_key) references public.role_definition (org_id, key)
);

create index membership_org_idx on public.membership (org_id);
create index membership_user_idx on public.membership (user_id);

alter table public.membership enable row level security;

-- Readable by: the user themself (own memberships across orgs — the ctx
-- resolver's bootstrap read, before an org GUC exists) OR members of the org.
-- Writable (update only: deactivation/role changes) strictly within the org.
create policy membership_access on public.membership
  for all to app_user
  using (
    user_id = (select app.current_user_id())
    or org_id = (select app.current_org_id())
  )
  with check (org_id = (select app.current_org_id()));

grant select, update on public.membership to app_user; -- inserts via definer fns only

create trigger membership_touch_updated_at
  before update on public.membership
  for each row execute function app.set_updated_at();

-- Now that membership exists: widen user_profile visibility to co-members of the
-- caller's active org (member lists) in addition to self.
drop policy user_profile_access on public.user_profile;
create policy user_profile_access on public.user_profile
  for all to app_user
  using (
    id = (select app.current_user_id())
    or exists (
      select 1 from public.membership m
      where m.user_id = user_profile.id
        and m.org_id = (select app.current_org_id())
        and m.deactivated_at is null
    )
  )
  with check (id = (select app.current_user_id()));

-- The ctx resolver's bootstrap read: before an org GUC exists, a user must be
-- able to list the orgs they belong to (org switcher, active-org validation).
-- Widen org SELECT-visibility to own-membership orgs; writes stay ctx-org-only.
drop policy org_tenant_isolation on public.org;
create policy org_tenant_isolation on public.org
  for all to app_user
  using (
    id = (select app.current_org_id())
    or exists (
      select 1 from public.membership m
      where m.org_id = org.id
        and m.user_id = (select app.current_user_id())
        and m.deactivated_at is null
    )
  )
  with check (id = (select app.current_org_id()));

-- ── membership_invite (own token flow — no service-role anywhere) ────────────
create table public.membership_invite (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  email text,
  phone text,
  role_key text not null,
  token_hash text not null unique, -- sha256(token); raw token never stored
  invited_by uuid not null references public.user_profile (id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references public.user_profile (id),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, role_key) references public.role_definition (org_id, key),
  check (email is not null or phone is not null)
);

create index membership_invite_org_idx on public.membership_invite (org_id);

alter table public.membership_invite enable row level security;

create policy membership_invite_tenant_isolation on public.membership_invite
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));

grant select, insert, update on public.membership_invite to app_user; -- revoke = update

create trigger membership_invite_touch_updated_at
  before update on public.membership_invite
  for each row execute function app.set_updated_at();

-- ── sign_in_log (append-only; doc 10 #31) ─────────────────────────────────────
create table public.sign_in_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.user_profile (id),
  org_id uuid references public.org (id),
  event text not null check (event in (
    'login_success','login_failure','logout','signup',
    'mfa_enrolled','mfa_challenge_success','mfa_challenge_failure','mfa_reset',
    'otp_sent','otp_verified','invite_sent','invite_accepted','membership_deactivated'
  )),
  detail jsonb not null default '{}',
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index sign_in_log_user_idx on public.sign_in_log (user_id, created_at);
create index sign_in_log_org_idx on public.sign_in_log (org_id, created_at);

alter table public.sign_in_log enable row level security;

-- Insertable pre-org (login events have no org ctx yet); readable by self or org.
create policy sign_in_log_access on public.sign_in_log
  for all to app_user
  using (
    user_id = (select app.current_user_id())
    or (org_id is not null and org_id = (select app.current_org_id()))
  )
  with check (
    (org_id is null or org_id = (select app.current_org_id()))
    and (user_id is null or user_id = (select app.current_user_id()) or (select app.current_user_id()) is null)
  );

grant select, insert on public.sign_in_log to app_user; -- append-only: no update/delete

-- ── Platform bootstrap: org creation (SECURITY DEFINER — the pre-ctx path) ───
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
begin
  if not exists (select 1 from public.user_profile where id = p_user_id) then
    raise exception 'unknown user';
  end if;
  if p_name is null or length(trim(p_name)) < 2 or length(p_name) > 120 then
    raise exception 'invalid org name';
  end if;

  -- Country-aware working-week defaults (audit C-4): UAE Mon–Fri; KSA and the
  -- rest of the GCC Sun–Thu; elsewhere Mon–Fri. Six-day workshop option adds Sat.
  v_working_week := case
    when p_country in ('SA','QA','KW','BH','OM') then
      case when p_six_day_week
        then '{"days":["sun","mon","tue","wed","thu","sat"]}'::jsonb
        else '{"days":["sun","mon","tue","wed","thu"]}'::jsonb end
    else
      case when p_six_day_week
        then '{"days":["mon","tue","wed","thu","fri","sat"]}'::jsonb
        else '{"days":["mon","tue","wed","thu","fri"]}'::jsonb end
  end;

  insert into public.org (name, country, timezone, base_currency, languages, working_week)
  values (p_name, upper(p_country), coalesce(p_timezone, 'Asia/Dubai'),
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

-- ── Platform bootstrap: invite acceptance (invitee has no org ctx yet) ───────
create or replace function app.accept_invite(p_token_hash text, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite record;
begin
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
