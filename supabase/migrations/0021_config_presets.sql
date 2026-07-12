-- 0021_config_presets (S1 — doc 09 #5 JobPreset as a TABLE because jobs FK it;
-- doc 07 reference sequences; role_definition becomes label/flag-editable via
-- the config pipeline the 0003 comment anticipated).
-- Rollback note: forward-only; drop table/policies (safe pre-data).

-- ── job_preset (the BoatModel generalisation — doc 01 L5) ────────────────────
create table public.job_preset (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  code text not null check (code ~ '^[A-Z0-9]{1,8}$'),
  names jsonb not null,                       -- {en, ar} (schema-validated in app)
  default_skipped_stage_keys jsonb not null default '[]'::jsonb,
  billing_points jsonb not null,              -- [{trigger, pct}] Σpct=100 (audit F-1)
  description text check (description is null or length(description) <= 200),
  retired_at timestamptz,                     -- D-9.2: retire, never delete
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index job_preset_org_code_uq on public.job_preset (org_id, code);
create index job_preset_org_idx on public.job_preset (org_id, retired_at);
alter table public.job_preset enable row level security;
create policy job_preset_select on public.job_preset
  for select to app_user using (org_id = (select app.current_org_id()));
create policy job_preset_insert on public.job_preset
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy job_preset_update on public.job_preset
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.job_preset to app_user;
grant update (names, default_skipped_stage_keys, billing_points, description, retired_at, updated_at)
  on public.job_preset to app_user;
-- code is deliberately NOT updatable (D-9.2: keys/codes immutable — references
-- like 24C-003 embed it forever). No DELETE grant — retire.

-- ── reference_sequence (hull numbers / serials; doc 07 "Reference patterns") ─
create table public.reference_sequence (
  org_id uuid not null references public.org (id) on delete restrict,
  scope_key text not null check (length(scope_key) between 1 and 64), -- e.g. 'job.24C'
  next_value bigint not null default 1 check (next_value >= 1),
  primary key (org_id, scope_key)
);
alter table public.reference_sequence enable row level security;
create policy reference_sequence_select on public.reference_sequence
  for select to app_user using (org_id = (select app.current_org_id()));
create policy reference_sequence_insert on public.reference_sequence
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy reference_sequence_update on public.reference_sequence
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.reference_sequence to app_user;
grant update (next_value) on public.reference_sequence to app_user;

-- ── role_definition: label/flag edits via the config pipeline ────────────────
-- Column-scoped so archetype/key can NEVER be changed by a tenant session
-- (role-escalation guard — the Phase C review minor made structural).
create policy role_definition_update on public.role_definition
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant update (label, cost_privileged, price_privileged, updated_at)
  on public.role_definition to app_user;

-- ── org_holiday_calendar: replace-on-apply needs DELETE ──────────────────────
-- The calendar is CONFIG reference data (no business record FKs it); every
-- replace goes through the pipeline, which records full before/after in
-- config_revision — history is preserved there, so row deletion is not data
-- loss (D-1.7 applies to business records, not derived config rows).
create policy org_holiday_calendar_delete on public.org_holiday_calendar
  for delete to app_user using (org_id = (select app.current_org_id()));
grant delete on public.org_holiday_calendar to app_user;
