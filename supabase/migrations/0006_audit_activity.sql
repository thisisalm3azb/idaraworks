-- 0006_audit_activity (S0 checklist §3 "audit_activity", renumbered)
-- Two append-only streams (doc 01 D-1.8): audit_log = security/config/financial
-- mutations (stricter, compliance retention); activity = operational narrative
-- on L2/L4 entities (tenant-visible). Both: RLS org-scoped, INSERT-only for
-- app_user (REVOKE UPDATE, DELETE — doc 10 #34). sign_in_log (0003) remains the
-- specialised auth-events stream.
-- Rollback note: drop both tables; safe pre-data.

-- ── audit_log ────────────────────────────────────────────────────────────────
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  actor_user_id uuid references public.user_profile (id),
  action text not null,               -- e.g. 'membership.deactivate', 'org.create'
  entity_type text not null,          -- attachable/entity type (registry-typed in app)
  entity_id uuid,
  summary text not null,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_org_created_idx on public.audit_log (org_id, created_at);
create index audit_log_entity_idx on public.audit_log (org_id, entity_type, entity_id);

alter table public.audit_log enable row level security;
create policy audit_log_access on public.audit_log
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (
    org_id = (select app.current_org_id())
    and actor_user_id = (select app.current_user_id())  -- the actor is the caller
  );
-- Append-only: insert + read within the org; NEVER update/delete (doc 10 #34).
grant select, insert on public.audit_log to app_user;
revoke update, delete on public.audit_log from app_user;

-- ── activity ─────────────────────────────────────────────────────────────────
create table public.activity (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  actor_user_id uuid references public.user_profile (id),
  entity_type text not null,
  entity_id uuid not null,
  verb text not null,                 -- past-tense: 'created', 'updated', 'commented'
  summary text not null,
  created_at timestamptz not null default now()
);
create index activity_org_entity_idx on public.activity (org_id, entity_type, entity_id, created_at);
create index activity_org_created_idx on public.activity (org_id, created_at);

alter table public.activity enable row level security;
create policy activity_access on public.activity
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (
    org_id = (select app.current_org_id())
    and actor_user_id = (select app.current_user_id())
  );
grant select, insert on public.activity to app_user;
revoke update, delete on public.activity from app_user;
