-- 0005_entitlements (S0 checklist §3 "entitlements", renumbered per A-B6 + Phase C)
-- entitlement_def (catalogue), plan, plan_entitlement, org_plan_state,
-- org_entitlement_override. Platform-managed reference tables: an org may READ
-- its own resolved entitlements; writes are platform-only (no app_user grant),
-- matching v1 §13 (billing events drive plan/override changes, not tenants).
-- Rollback note: drop tables in reverse; extend-back create_org_with_owner.

-- ── entitlement_def: the catalogue (mirrors src/platform/entitlements/catalogue.ts) ──
create table public.entitlement_def (
  key text primary key,
  kind text not null check (kind in ('feature', 'limit')),
  created_at timestamptz not null default now()
);
-- Global reference data (not org-scoped): readable by all app_user, writable by
-- no app_user. No org_id => not a tenant table => intentionally no RLS policy,
-- but we still lock it down: revoke writes, grant read only.
alter table public.entitlement_def enable row level security;
create policy entitlement_def_read on public.entitlement_def for select to app_user using (true);
grant select on public.entitlement_def to app_user;

insert into public.entitlement_def (key, kind) values
  ('cap.jobs','feature'), ('cap.daily_reports','feature'), ('cap.issues','feature'),
  ('cap.approvals','feature'), ('cap.procurement','feature'), ('cap.quoting','feature'),
  ('cap.invoicing','feature'), ('cap.expenses_costing','feature'), ('cap.customers','feature'),
  ('cap.people','feature'), ('cap.customer_updates','feature'),
  ('feat.ai_onboarding','feature'), ('feat.ai_narration','feature'), ('feat.ai_drafts','feature'),
  ('feat.custom_fields','feature'), ('feat.org_terminology_overrides','feature'),
  ('feat.audit_export','feature'),
  ('limit.full_users','limit'), ('limit.field_users','limit'), ('limit.viewer_users','limit'),
  ('limit.active_jobs','limit'), ('limit.storage_gb','limit'), ('limit.ai_credits_month','limit'),
  ('limit.custom_fields_per_entity','limit'), ('limit.presets','limit');

-- ── plan ─────────────────────────────────────────────────────────────────────
create table public.plan (
  key text primary key,
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.plan enable row level security;
create policy plan_read on public.plan for select to app_user using (true);
grant select on public.plan to app_user;

insert into public.plan (key, name, sort_order) values
  ('starter','Starter',1), ('growth','Growth',2), ('business','Business',3);

-- ── plan_entitlement: plan × entitlement value ──────────────────────────────
-- feature → enabled (bool); limit → limit_value (null = unlimited).
create table public.plan_entitlement (
  plan_key text not null references public.plan (key) on delete restrict,
  entitlement_key text not null references public.entitlement_def (key) on delete restrict,
  enabled boolean,
  limit_value bigint,
  primary key (plan_key, entitlement_key)
);
alter table public.plan_entitlement enable row level security;
create policy plan_entitlement_read on public.plan_entitlement for select to app_user using (true);
grant select on public.plan_entitlement to app_user;

-- Seed values (doc 09 tier hypotheses — PLACEHOLDER numbers pending OP-2/D3).
-- All three tiers enable the full MVP capability set (features are gated by
-- release, not tier, at this stage); tiers differ on limits.
-- Features: on for all tiers.
insert into public.plan_entitlement (plan_key, entitlement_key, enabled)
select p.key, e.key, true
from public.plan p cross join public.entitlement_def e
where e.kind = 'feature';

-- Limits per tier (null = unlimited). field_users/viewer_users unlimited everywhere.
insert into public.plan_entitlement (plan_key, entitlement_key, limit_value) values
  ('starter','limit.full_users',5),    ('growth','limit.full_users',15),   ('business','limit.full_users',40),
  ('starter','limit.field_users',null), ('growth','limit.field_users',null), ('business','limit.field_users',null),
  ('starter','limit.viewer_users',null),('growth','limit.viewer_users',null),('business','limit.viewer_users',null),
  ('starter','limit.active_jobs',10),   ('growth','limit.active_jobs',40),  ('business','limit.active_jobs',150),
  ('starter','limit.storage_gb',25),    ('growth','limit.storage_gb',100),  ('business','limit.storage_gb',500),
  ('starter','limit.ai_credits_month',2000),('growth','limit.ai_credits_month',8000),('business','limit.ai_credits_month',30000),
  ('starter','limit.custom_fields_per_entity',10),('growth','limit.custom_fields_per_entity',25),('business','limit.custom_fields_per_entity',50),
  ('starter','limit.presets',5),        ('growth','limit.presets',15),      ('business','limit.presets',50);

-- ── org_plan_state: which plan an org is on + billing state ──────────────────
create table public.org_plan_state (
  org_id uuid primary key references public.org (id) on delete restrict,
  plan_key text not null references public.plan (key) on delete restrict,
  billing_state text not null default 'trialing'
    check (billing_state in ('internal_pilot','trialing','active','past_due','grace','suspended','cancelled')),
  period_start timestamptz not null default now(),
  period_end timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.org_plan_state enable row level security;
create policy org_plan_state_read on public.org_plan_state
  for select to app_user using (org_id = (select app.current_org_id()));
-- Read-only to tenants; plan changes are platform/billing actions (S9). No write grant.
grant select on public.org_plan_state to app_user;
create trigger org_plan_state_touch_updated_at
  before update on public.org_plan_state
  for each row execute function app.set_updated_at();

-- ── org_entitlement_override: per-org grants/exceptions layered on the plan ──
create table public.org_entitlement_override (
  org_id uuid not null references public.org (id) on delete restrict,
  entitlement_key text not null references public.entitlement_def (key) on delete restrict,
  enabled boolean,
  limit_value bigint,
  reason text,
  created_at timestamptz not null default now(),
  primary key (org_id, entitlement_key)
);
alter table public.org_entitlement_override enable row level security;
create policy org_entitlement_override_read on public.org_entitlement_override
  for select to app_user using (org_id = (select app.current_org_id()));
-- Read-only to tenants; overrides are platform/sales actions. No write grant.
grant select on public.org_entitlement_override to app_user;

-- ── Extend org creation to assign the default plan atomically ────────────────
-- (Third revision; forward-only via CREATE OR REPLACE. Adds the org_plan_state
--  insert; all prior 0004 hardening — session-user binding, uppercased country —
--  preserved verbatim.)
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

  -- Default plan: full-featured Growth trial (v1 §13). billing_state machine = S9.
  insert into public.org_plan_state (org_id, plan_key, billing_state)
  values (v_org_id, 'growth', 'trialing');

  return v_org_id;
end
$$;

revoke all on function app.create_org_with_owner(uuid, text, char, char, text, text[], boolean) from public;
grant execute on function app.create_org_with_owner(uuid, text, char, char, text, text[], boolean) to app_user;
