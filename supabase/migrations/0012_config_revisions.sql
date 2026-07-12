-- 0012_config_revisions (S0 checklist §3 "config_revisions", renumbered)
-- config_revision — the detailed before/after history for every org config
-- artifact (terminology map, presets, custom fields, calendars, …). Doc 01 D-1.8:
-- config mutations also go to audit_log (the compliance summary); config_revision
-- holds the full diff for the config-history UI. Append-only, like audit.
-- The config-EDITING pipeline is S1; this table exists now so the audit path is
-- complete from the first config write.
-- Rollback note: drop the table; safe pre-data.

create table public.config_revision (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  artifact_key text not null,            -- e.g. 'terminology.overrides', 'preset.<id>'
  before_data jsonb,                     -- null on first creation
  after_data jsonb,                      -- null on delete
  actor_user_id uuid references public.user_profile (id),
  ai_flag boolean not null default false, -- was this revision AI-suggested/authored
  summary text,
  created_at timestamptz not null default now()
);
create index config_revision_org_artifact_idx
  on public.config_revision (org_id, artifact_key, created_at);
create index config_revision_org_created_idx
  on public.config_revision (org_id, created_at);

alter table public.config_revision enable row level security;
-- Config history is org-scoped; reads gated to privileged archetypes (config is
-- an admin/owner concern — mirrors the audit_log read posture).
create policy config_revision_select on public.config_revision
  for select to app_user
  using (
    org_id = (select app.current_org_id())
    and exists (
      select 1 from public.membership m
      join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
      where m.org_id = (select app.current_org_id())
        and m.user_id = (select app.current_user_id())
        and m.deactivated_at is null
        and r.archetype in ('owner', 'admin')
    )
  );
create policy config_revision_insert on public.config_revision
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and actor_user_id = (select app.current_user_id())
  );
-- Append-only: insert + read; NEVER update/delete (config history is immutable).
grant select, insert on public.config_revision to app_user;
revoke update, delete on public.config_revision from app_user;
