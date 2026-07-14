-- 0050_s8_onboarding_imports (S8 — "AI Onboarding & Imports"): the onboarding session that
-- turns a structured intake into a validated ConfigProposal applied as undoable config
-- revisions (doc 11 S8; doc 09 #12/F-28), plus CSV import staging for customers/employees/
-- items (guided imports), plus the per-org onboarding-call cap (doc 10 #32 trial abuse).
--
-- The Layer-A pipeline is a VALIDATOR AROUND TEMPLATES, not an agent: the proposal is a
-- structured artifact grounded on template #1, every artifact re-validated by its S1 schema
-- and applied via applyConfigChange (aiFlag=true) so undo/audit already work. Nothing here
-- grants a capability the config pipeline didn't already govern. Forward-only.

-- ── onboarding_session ───────────────────────────────────────────────────────
-- One guided onboarding run. `intake` = the structured answers; `proposal` = the frozen
-- ConfigProposal (validated) awaiting review; `applied_revision_ids` = the config_revision
-- ids created on apply (so a session-level undo can walk them). Metered AI calls are counted
-- from ai_interaction(feature='config_proposal'), not stored here.
create table public.onboarding_session (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  status text not null default 'draft'
    check (status in ('draft', 'proposed', 'applied', 'dismissed')),
  template_key text not null check (length(template_key) between 1 and 80),
  -- Structured intake answers (business type, terminology, currency, calendar, VAT, sizes).
  intake jsonb not null default '{}'::jsonb,
  -- The validated ConfigProposal (intake_summary, artifacts, rationale, requires_upgrade).
  proposal jsonb,
  -- config_revision ids applied from this session (for a session-scoped undo/audit trail).
  applied_revision_ids uuid[] not null default '{}',
  requires_upgrade text[] not null default '{}',
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint onboarding_session_id_org_uq unique (id, org_id),
  constraint onboarding_session_proposed_ck check (status = 'draft' or proposal is not null)
);
create index onboarding_session_org_status_idx
  on public.onboarding_session (org_id, status, created_at desc);
alter table public.onboarding_session enable row level security;
create policy onboarding_session_select on public.onboarding_session
  for select to app_user using (org_id = (select app.current_org_id()));
create policy onboarding_session_insert on public.onboarding_session
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and created_by = (select app.current_user_id()));
create policy onboarding_session_update on public.onboarding_session
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.onboarding_session to app_user;
-- No DELETE grant (D-1.7). Progression through the states updates these columns only.
grant update (status, intake, proposal, applied_revision_ids, requires_upgrade, updated_at)
  on public.onboarding_session to app_user;

-- ── import_batch ─────────────────────────────────────────────────────────────
-- A guided CSV import (customers | employees | items). Staged rows validate individually and
-- apply through the governed masters services; a batch is re-runnable (only pending/invalid
-- rows re-apply). Cost-only staging; nothing external.
create table public.import_batch (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  kind text not null check (kind in ('customers', 'employees', 'items')),
  status text not null default 'staged'
    check (status in ('staged', 'validated', 'applied', 'failed')),
  source_filename text check (source_filename is null or length(source_filename) <= 260),
  row_count integer not null default 0 check (row_count >= 0),
  applied_count integer not null default 0 check (applied_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_batch_id_org_uq unique (id, org_id)
);
create index import_batch_org_idx on public.import_batch (org_id, created_at desc);
alter table public.import_batch enable row level security;
create policy import_batch_select on public.import_batch
  for select to app_user using (org_id = (select app.current_org_id()));
create policy import_batch_insert on public.import_batch
  for insert to app_user
  with check (org_id = (select app.current_org_id()) and created_by = (select app.current_user_id()));
create policy import_batch_update on public.import_batch
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.import_batch to app_user;
grant update (status, row_count, applied_count, error_count, updated_at)
  on public.import_batch to app_user;

-- ── import_row (unbounded-growth: reads MUST page — selectAll/range) ──────────
create table public.import_row (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  batch_id uuid not null,
  row_number integer not null check (row_number >= 1),
  -- The raw parsed CSV cells and the normalised mapped payload.
  raw jsonb not null default '{}'::jsonb,
  mapped jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'valid', 'invalid', 'applied', 'skipped')),
  error text check (error is null or length(error) <= 500),
  created_entity_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_row_batch_org_fk foreign key (batch_id, org_id)
    references public.import_batch (id, org_id) on delete restrict,
  constraint import_row_batch_rownum_uq unique (batch_id, row_number)
);
create index import_row_batch_idx on public.import_row (org_id, batch_id, row_number);
alter table public.import_row enable row level security;
create policy import_row_select on public.import_row
  for select to app_user using (org_id = (select app.current_org_id()));
create policy import_row_insert on public.import_row
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy import_row_update on public.import_row
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.import_row to app_user;
grant update (mapped, status, error, created_entity_id, updated_at) on public.import_row to app_user;

-- ── ai_interaction: add the onboarding metering feature key ───────────────────
-- The Layer-A proposal generation is a metered AI surface (doc 09: narration/drafts/
-- conversation are metered) — count it against the per-org onboarding cap. Forward-only.
alter table public.ai_interaction drop constraint ai_interaction_feature_check;
alter table public.ai_interaction add constraint ai_interaction_feature_check
  check (feature in ('digest_narration', 'customer_draft', 'config_proposal'));

-- ── entitlement: per-org onboarding-call cap (doc 10 #32 / F-26) ──────────────
insert into public.entitlement_def (key, kind) values ('limit.ai_onboarding_calls', 'limit');
-- Free funnel: the same modest per-org cap on every tier (a trial-abuse ceiling, not a
-- tier differentiator). PLACEHOLDER number pending OP-2/D3.
insert into public.plan_entitlement (plan_key, entitlement_key, limit_value) values
  ('starter', 'limit.ai_onboarding_calls', 30),
  ('growth', 'limit.ai_onboarding_calls', 30),
  ('business', 'limit.ai_onboarding_calls', 30);
