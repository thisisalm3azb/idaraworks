-- 0056_s9_impersonation (S9 part 4): consent-gated, dual-logged support impersonation +
-- the minimal platform-staff model it requires. DoD AC: "a support session is visible in the
-- tenant's OWN audit log." Forward-only.
--
-- No platform-staff concept existed before S9. platform_staff is a tiny allow-list of IdaraWorks
-- staff user ids — deliberately minimal (not a full RBAC): it only gates who may open an
-- impersonation session. It is platform-managed (no tenant grant).

-- ── platform_staff: the allow-list of IdaraWorks support/platform operators ─────────────────────
create table public.platform_staff (
  user_id uuid primary key references public.user_profile (id) on delete restrict,
  active boolean not null default true,
  note text check (note is null or length(note) <= 200),
  added_at timestamptz not null default now()
);
alter table public.platform_staff enable row level security;
-- Platform-only: no tenant policy, no grant. Reached only via the DEFINER guard below.

-- ── impersonation_session: one governed support session (consent OR break-glass, dual-logged) ───
create table public.impersonation_session (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  staff_user_id uuid not null references public.user_profile (id) on delete restrict,
  reason text not null check (length(reason) between 3 and 500),
  -- Consent: EITHER a tenant admin/owner explicitly granted access, OR break-glass (an emergency
  -- override that is always logged + notified). One of the two MUST hold — never neither.
  consent_granted_by uuid references public.user_profile (id),
  break_glass boolean not null default false,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint impersonation_consent_ck check (consent_granted_by is not null or break_glass),
  constraint impersonation_id_org_uq unique (id, org_id)
);
create index impersonation_session_org_idx on public.impersonation_session (org_id, started_at);
-- Active sessions (for the banner + a break-glass alert sweep).
create index impersonation_session_active_idx
  on public.impersonation_session (org_id) where ended_at is null;
alter table public.impersonation_session enable row level security;
-- The TENANT may READ its own impersonation sessions (transparency — who accessed my org, when,
-- why). It may not write them. Platform staff write via the DEFINER functions.
create policy impersonation_session_read on public.impersonation_session
  for select to app_user using (org_id = (select app.current_org_id()));
grant select on public.impersonation_session to app_user;

-- ── start_impersonation: staff-gated, consent-checked, DUAL-LOGGED ──────────────────────────────
-- Platform-task only (staff acts without a tenant GUC). Verifies the actor is active platform_staff,
-- enforces the consent-or-break-glass invariant, records the session, and writes to BOTH the tenant's
-- own audit_log (via record_platform_audit) AND — implicitly — the platform stream. Returns the id.
create or replace function app.start_impersonation(
  p_org uuid,
  p_staff uuid,
  p_reason text,
  p_consent_granted_by uuid,
  p_break_glass boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform app.assert_platform_task();
  if not exists (select 1 from public.platform_staff where user_id = p_staff and active) then
    raise exception 'start_impersonation: % is not active platform staff', p_staff;
  end if;
  if p_consent_granted_by is null and not coalesce(p_break_glass, false) then
    raise exception 'start_impersonation: consent or break-glass required';
  end if;
  insert into public.impersonation_session (org_id, staff_user_id, reason, consent_granted_by, break_glass)
  values (p_org, p_staff, p_reason, p_consent_granted_by, coalesce(p_break_glass, false))
  returning id into v_id;
  -- Tenant-visible audit (the DoD AC). Actor = the staff user; the reason + mode are recorded.
  perform app.record_platform_audit(
    p_org, p_staff, 'support.impersonation_started', 'impersonation_session', v_id,
    'Support session started' || case when p_break_glass then ' (break-glass)' else '' end,
    jsonb_build_object('reason', p_reason, 'break_glass', coalesce(p_break_glass, false)));
  return v_id;
end
$$;
revoke all on function app.start_impersonation(uuid, uuid, text, uuid, boolean) from public;
grant execute on function app.start_impersonation(uuid, uuid, text, uuid, boolean) to app_user;

-- ── end_impersonation: close the session, dual-logged ──────────────────────────────────────────
create or replace function app.end_impersonation(p_session uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_staff uuid;
begin
  perform app.assert_platform_task();
  update public.impersonation_session set ended_at = now()
    where id = p_session and ended_at is null
    returning org_id, staff_user_id into v_org, v_staff;
  if v_org is not null then
    perform app.record_platform_audit(
      v_org, v_staff, 'support.impersonation_ended', 'impersonation_session', p_session,
      'Support session ended', '{}'::jsonb);
  end if;
end
$$;
revoke all on function app.end_impersonation(uuid) from public;
grant execute on function app.end_impersonation(uuid) to app_user;
