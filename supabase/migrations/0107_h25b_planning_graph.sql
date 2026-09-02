-- 0107_h25b_planning_graph (H25 — Management Studio: the canonical planning
-- graph, canonical dependency extension, and two drift repairs).
--
-- ONE LIVING MODEL (ADR-1/ADR-2): the studio adds a typed graph that either
-- LINKS a canonical record (record_type + record_id, validated in the service
-- against a closed registry) or holds PLANNING-ONLY content until it is
-- explicitly converted into a real record. Linked records' status, dates,
-- assignments, money and progress are never copied into these tables — every
-- view resolves them through the owning module at read time.
--
-- House laws throughout: org_id + RLS on every table, composite (id, org_id)
-- pins on every cross-table reference, column-scoped UPDATE grants, author
-- backstop on INSERT, and NO DELETE grants — removal is soft or archival.

-- ── Drift repair 1 (audit §3.1): the approval subject CHECKs stopped at
-- pay_run (0095), making journal_entry rules impossible and the H24
-- segregation gate unreachable. Widen to the FULL code registry, plus the
-- H25 subject (scenario_apply — approval-gated in the studio service, no
-- SUBJECTS dispatch entry, exactly the journal_entry precedent).
alter table public.approval drop constraint approval_subject_type_check;
alter table public.approval
  add constraint approval_subject_type_check check (subject_type in (
    'material_request', 'expense', 'quote_send', 'purchase_order', 'payment',
    'task_completion', 'asset_disposal', 'leave_request', 'overtime_request',
    'expense_claim', 'pay_run', 'journal_entry', 'scenario_apply'
  ));
alter table public.approval_rule drop constraint approval_rule_subject_type_check;
alter table public.approval_rule
  add constraint approval_rule_subject_type_check check (subject_type in (
    'material_request', 'expense', 'quote_send', 'purchase_order', 'payment',
    'task_completion', 'asset_disposal', 'leave_request', 'overtime_request',
    'expense_claim', 'pay_run', 'journal_entry', 'scenario_apply'
  ));

-- ── Drift repair 2 (audit §3.3): the week-view partial index predates H21's
-- task statuses; rebuild over every open status so /week queries stay covered.
drop index if exists task_org_due_idx;
create index task_org_due_idx on public.task (org_id, due_date)
  where status in ('pending', 'ready', 'in_progress', 'blocked', 'awaiting_approval');

-- ── ADR-6: the canonical dependency model grows the three remaining kinds
-- plus lead/lag, additively (existing values preserved).
alter table public.task_dependency drop constraint task_dependency_kind_check;
alter table public.task_dependency
  add constraint task_dependency_kind_check check (kind in (
    'finish_to_start', 'start_to_start', 'finish_to_finish', 'start_to_finish',
    'blocks'
  ));
alter table public.task_dependency
  add column lag_days integer not null default 0
    check (lag_days between -365 and 365);
grant update (lag_days) on public.task_dependency to app_user;

-- ── Scheduling fields the canonical task was missing (duration in WORKING
-- days, constraints, deadline, milestone flag). All additive and nullable —
-- ordinary checklist tasks keep working untouched.
alter table public.task
  add column duration_days integer
    check (duration_days is null or (duration_days >= 0 and duration_days <= 3650)),
  add column is_milestone boolean not null default false,
  add column constraint_kind text not null default 'none'
    check (constraint_kind in ('none', 'start_no_earlier', 'finish_no_later')),
  add column constraint_date date,
  add column deadline_date date,
  -- Three-point estimate for schedule-risk simulation (H25G): explicit user
  -- inputs in working days; the engine REFUSES to simulate without them.
  add column estimate_optimistic_days numeric(7, 2)
    check (estimate_optimistic_days is null or estimate_optimistic_days >= 0),
  add column estimate_pessimistic_days numeric(7, 2)
    check (estimate_pessimistic_days is null or estimate_pessimistic_days >= 0);
alter table public.task
  add constraint task_constraint_date_ck
  check ((constraint_kind = 'none') = (constraint_date is null));
grant update (duration_days, is_milestone, constraint_kind, constraint_date,
              deadline_date, estimate_optimistic_days, estimate_pessimistic_days)
  on public.task to app_user;

-- ── plan: the studio document (a canvas + every projection of it) ───────────
create table public.studio_plan (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,
  name text not null check (length(trim(name)) between 1 and 200),
  description text check (description is null or length(description) <= 4000),
  status text not null default 'active' check (status in ('active', 'archived')),
  -- Default view + studio settings (never authority over data).
  settings jsonb not null default '{}',
  row_version bigint not null default 1,
  created_by uuid not null references public.user_profile (id),
  updated_by uuid references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studio_plan_id_org_uq unique (id, org_id),
  constraint studio_plan_reference_uq unique (org_id, reference)
);
create index studio_plan_org_idx on public.studio_plan (org_id, status, updated_at desc);
alter table public.studio_plan enable row level security;
create policy studio_plan_select on public.studio_plan
  for select to app_user using (org_id = (select app.current_org_id()));
create policy studio_plan_insert on public.studio_plan
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy studio_plan_update on public.studio_plan
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.studio_plan to app_user;
grant update (name, description, status, settings, row_version, updated_by, updated_at)
  on public.studio_plan to app_user;

-- ── studio_node: one typed element of the living model ────────────────────────
-- Either PLANNING-ONLY (record_type/record_id null) or a LINK to a canonical
-- record. A linked node carries NO copied business fields — the service
-- resolves them from the owning module at read time. node_type is the closed
-- semantic vocabulary (mandate H25B); `data` holds type-specific fields
-- validated per-type by the service with zod (risk likelihood/impact,
-- decision options, KPI binding…). Business calculations read validated
-- semantic types, never colors or labels.
create table public.studio_node (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  plan_id uuid not null,
  node_type text not null check (node_type in (
    -- structure & strategy
    'portfolio', 'program', 'objective', 'key_result', 'initiative',
    'project', 'phase', 'milestone', 'task', 'deliverable',
    -- governance registers
    'decision', 'assumption', 'constraint', 'issue', 'risk', 'opportunity',
    'change', 'action', 'lesson',
    -- resources & money
    'resource_requirement', 'budget_allocation', 'capacity_allocation',
    'kpi', 'outcome', 'benefit',
    -- canvas vocabulary (shape library)
    'process', 'person', 'team', 'customer', 'supplier', 'system',
    'document', 'database', 'warehouse', 'money', 'start_end', 'note',
    'group', 'swimlane', 'frame', 'custom'
  )),
  title text check (title is null or length(title) <= 300),
  description text check (description is null or length(description) <= 4000),
  -- Canonical record link (closed registry validated in the service; the pair
  -- is all-or-nothing). No FK by design — polymorphic, same law as `file`.
  record_type text check (record_type is null or length(record_type) <= 40),
  record_id uuid,
  constraint studio_node_link_ck check ((record_type is null) = (record_id is null)),
  -- Planning fields for UNLINKED content (drafts, objectives, risks…).
  status text not null default 'proposed'
    check (status in ('proposed', 'active', 'done', 'dropped')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  start_date date,
  due_date date,
  duration_days integer
    check (duration_days is null or (duration_days >= 0 and duration_days <= 3650)),
  progress_pct numeric(5, 2)
    check (progress_pct is null or (progress_pct >= 0 and progress_pct <= 100)),
  owner_user_id uuid references public.user_profile (id),
  assignee_employee_id uuid,
  amount_minor bigint,
  currency char(3),
  data jsonb not null default '{}',
  -- Canvas placement. Nested frames/groups via parent_node_id; layers by key.
  x numeric(12, 2) not null default 0,
  y numeric(12, 2) not null default 0,
  w numeric(12, 2),
  h numeric(12, 2),
  z integer not null default 0,
  parent_node_id uuid,
  layer_key text check (layer_key is null or length(layer_key) <= 40),
  locked boolean not null default false,
  style jsonb not null default '{}',
  row_version bigint not null default 1,
  archived_at timestamptz,
  created_by uuid not null references public.user_profile (id),
  updated_by uuid references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studio_node_id_org_uq unique (id, org_id),
  constraint studio_node_plan_fk foreign key (plan_id, org_id)
    references public.studio_plan (id, org_id) on delete restrict,
  constraint studio_node_parent_fk foreign key (parent_node_id, org_id)
    references public.studio_node (id, org_id),
  constraint studio_node_parent_not_self_ck
    check (parent_node_id is null or parent_node_id <> id),
  constraint studio_node_assignee_fk foreign key (assignee_employee_id, org_id)
    references public.employee (id, org_id),
  constraint studio_node_money_ck check ((amount_minor is null) or (currency is not null))
);
create index studio_node_plan_idx on public.studio_node (org_id, plan_id)
  where archived_at is null;
create index studio_node_record_idx on public.studio_node (org_id, record_type, record_id)
  where record_id is not null;
create index studio_node_type_idx on public.studio_node (org_id, node_type)
  where archived_at is null;
create index studio_node_parent_idx on public.studio_node (org_id, parent_node_id)
  where parent_node_id is not null;
alter table public.studio_node enable row level security;
create policy studio_node_select on public.studio_node
  for select to app_user using (org_id = (select app.current_org_id()));
create policy studio_node_insert on public.studio_node
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy studio_node_update on public.studio_node
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.studio_node to app_user;
grant update (title, description, status, priority, start_date, due_date,
              duration_days, progress_pct, owner_user_id, assignee_employee_id,
              amount_minor, currency, data, x, y, w, h, z, parent_node_id,
              layer_key, locked, style, row_version, archived_at, updated_by,
              updated_at)
  on public.studio_node to app_user;

-- ── studio_edge: a typed relationship between two nodes ───────────────────────
-- dependency edges between two LINKED tasks are materialized canonically: the
-- service creates the task_dependency row and stores its id here, so the
-- scheduling engine reads ONE dependency truth. Soft removal like task_dependency.
create table public.studio_edge (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  plan_id uuid not null,
  source_node_id uuid not null,
  target_node_id uuid not null,
  edge_type text not null default 'reference' check (edge_type in (
    'dependency', 'flow', 'approval', 'responsibility', 'financial',
    'material', 'customer', 'risk_influence', 'contribution', 'cause_effect',
    'reference'
  )),
  dep_kind text check (dep_kind is null or dep_kind in (
    'finish_to_start', 'start_to_start', 'finish_to_finish', 'start_to_finish'
  )),
  lag_days integer not null default 0 check (lag_days between -365 and 365),
  task_dependency_id uuid,
  label text check (label is null or length(label) <= 200),
  style jsonb not null default '{}',
  waypoints jsonb not null default '[]',
  row_version bigint not null default 1,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references public.user_profile (id),
  constraint studio_edge_id_org_uq unique (id, org_id),
  constraint studio_edge_plan_fk foreign key (plan_id, org_id)
    references public.studio_plan (id, org_id) on delete restrict,
  constraint studio_edge_source_fk foreign key (source_node_id, org_id)
    references public.studio_node (id, org_id),
  constraint studio_edge_target_fk foreign key (target_node_id, org_id)
    references public.studio_node (id, org_id),
  constraint studio_edge_not_self_ck check (source_node_id <> target_node_id),
  constraint studio_edge_dep_kind_ck
    check ((edge_type = 'dependency') = (dep_kind is not null))
);
create unique index studio_edge_live_uq
  on public.studio_edge (org_id, source_node_id, target_node_id, edge_type)
  where removed_at is null;
create index studio_edge_plan_idx on public.studio_edge (org_id, plan_id)
  where removed_at is null;
alter table public.studio_edge enable row level security;
create policy studio_edge_select on public.studio_edge
  for select to app_user using (org_id = (select app.current_org_id()));
create policy studio_edge_insert on public.studio_edge
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy studio_edge_update on public.studio_edge
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.studio_edge to app_user;
grant update (dep_kind, lag_days, task_dependency_id, label, style, waypoints,
              row_version, removed_at, removed_by)
  on public.studio_edge to app_user;

-- ── studio_view: saved projections (private or shared) ────────────────────────
create table public.studio_view (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  plan_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 120),
  view_kind text not null check (view_kind in (
    'canvas', 'board', 'table', 'gantt', 'timeline', 'calendar', 'roadmap',
    'network', 'critical_path', 'workload', 'heatmap', 'risk_matrix',
    'cost_map', 'strategy', 'portfolio', 'geo_map', 'three_d'
  )),
  -- filters, grouping, sorting, visible fields, zoom, camera, layers,
  -- time range, scenario, comparison baseline — presentation only.
  config jsonb not null default '{}',
  is_shared boolean not null default false,
  owner_user_id uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studio_view_id_org_uq unique (id, org_id),
  constraint studio_view_plan_fk foreign key (plan_id, org_id)
    references public.studio_plan (id, org_id) on delete restrict
);
create index studio_view_plan_idx on public.studio_view (org_id, plan_id);
alter table public.studio_view enable row level security;
-- Private views are the owner's; shared views are the plan's.
create policy studio_view_select on public.studio_view
  for select to app_user
  using (org_id = (select app.current_org_id())
         and (is_shared or owner_user_id = (select app.current_user_id())));
create policy studio_view_insert on public.studio_view
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and owner_user_id = (select app.current_user_id()));
create policy studio_view_update on public.studio_view
  for update to app_user
  using (org_id = (select app.current_org_id())
         and owner_user_id = (select app.current_user_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.studio_view to app_user;
grant update (name, config, is_shared, updated_at) on public.studio_view to app_user;

-- ── scenario: an overlay branch of a live plan (ADR-7) ──────────────────────
create table public.studio_scenario (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  plan_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 200),
  description text check (description is null or length(description) <= 4000),
  status text not null default 'draft' check (status in (
    'draft', 'under_review', 'approved', 'applied', 'discarded'
  )),
  is_shared boolean not null default false,
  -- The assumption register: [{text, confidence: low|medium|high, owner?}]
  assumptions jsonb not null default '[]',
  -- Monte Carlo reproducibility: the seed and sample count of the LAST run.
  simulation jsonb not null default '{}',
  -- The decision record (question/options/evidence/recommendation/decision).
  decision jsonb not null default '{}',
  base_captured_at timestamptz not null default now(),
  applied_at timestamptz,
  applied_by uuid references public.user_profile (id),
  row_version bigint not null default 1,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studio_scenario_id_org_uq unique (id, org_id),
  constraint studio_scenario_plan_fk foreign key (plan_id, org_id)
    references public.studio_plan (id, org_id) on delete restrict,
  constraint studio_scenario_applied_ck
    check ((status = 'applied') = (applied_at is not null))
);
create index studio_scenario_plan_idx on public.studio_scenario (org_id, plan_id, status);
alter table public.studio_scenario enable row level security;
create policy studio_scenario_select on public.studio_scenario
  for select to app_user
  using (org_id = (select app.current_org_id())
         and (is_shared or created_by = (select app.current_user_id())
              or status in ('under_review', 'approved', 'applied')));
create policy studio_scenario_insert on public.studio_scenario
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy studio_scenario_update on public.studio_scenario
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.studio_scenario to app_user;
grant update (name, description, status, is_shared, assumptions, simulation,
              decision, applied_at, applied_by, row_version, updated_at)
  on public.studio_scenario to app_user;

-- ── studio_scenario_change: one overlaid field value (last write per field) ────────
create table public.studio_scenario_change (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  scenario_id uuid not null,
  -- node/edge target a studio element; record targets a canonical record
  -- (task/job) field — applied through the OWNING service on approval.
  target_kind text not null check (target_kind in ('node', 'edge', 'record')),
  target_id uuid not null,
  record_type text check (record_type is null or length(record_type) <= 40),
  field text not null check (length(field) <= 60),
  old_value jsonb,
  new_value jsonb,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studio_scenario_change_id_org_uq unique (id, org_id),
  constraint studio_scenario_change_scenario_fk foreign key (scenario_id, org_id)
    references public.studio_scenario (id, org_id) on delete restrict,
  constraint studio_scenario_change_record_ck
    check ((target_kind = 'record') = (record_type is not null)),
  constraint studio_scenario_change_field_uq unique (org_id, scenario_id, target_kind, target_id, field)
);
alter table public.studio_scenario_change enable row level security;
create policy studio_scenario_change_select on public.studio_scenario_change
  for select to app_user using (org_id = (select app.current_org_id()));
create policy studio_scenario_change_insert on public.studio_scenario_change
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy studio_scenario_change_update on public.studio_scenario_change
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.studio_scenario_change to app_user;
grant update (old_value, new_value, updated_at) on public.studio_scenario_change to app_user;

-- ── studio_baseline: frozen schedule snapshots (baselines ARE copies) ─────────
create table public.studio_baseline (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  plan_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 120),
  -- [{key, title, start, finish, durationDays, amountMinor?}] — deliberately
  -- a snapshot: a baseline's whole meaning is that it does not move.
  snapshot jsonb not null default '[]',
  captured_by uuid not null references public.user_profile (id),
  captured_at timestamptz not null default now(),
  constraint studio_baseline_id_org_uq unique (id, org_id),
  constraint studio_baseline_plan_fk foreign key (plan_id, org_id)
    references public.studio_plan (id, org_id) on delete restrict,
  constraint studio_baseline_name_uq unique (org_id, plan_id, name)
);
alter table public.studio_baseline enable row level security;
create policy studio_baseline_select on public.studio_baseline
  for select to app_user using (org_id = (select app.current_org_id()));
create policy studio_baseline_insert on public.studio_baseline
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and captured_by = (select app.current_user_id()));
grant select, insert on public.studio_baseline to app_user;
-- No UPDATE grant at all: a baseline is immutable from birth.

-- ── studio_version: named checkpoints of the DRAFT/canvas layer ───────────────
-- Restore never rolls back canonical records (audit law); it re-applies the
-- draft graph and layout through the service.
create table public.studio_version (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  plan_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 120),
  snapshot jsonb not null default '{}',
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint studio_version_id_org_uq unique (id, org_id),
  constraint studio_version_plan_fk foreign key (plan_id, org_id)
    references public.studio_plan (id, org_id) on delete restrict
);
create index studio_version_plan_idx on public.studio_version (org_id, plan_id, created_at desc);
alter table public.studio_version enable row level security;
create policy studio_version_select on public.studio_version
  for select to app_user using (org_id = (select app.current_org_id()));
create policy studio_version_insert on public.studio_version
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
grant select, insert on public.studio_version to app_user;
-- Checkpoints are immutable: no UPDATE grant.

-- ── the studio capability (same law as cap.finance in 0101): enabled on
-- every plan; surfaces stay invisible behind FEATURE_MANAGEMENT_STUDIO until
-- verified end to end. Mirrors entitlements/catalogue.ts (parity test).
insert into public.entitlement_def (key, kind) values ('cap.studio', 'feature');
insert into public.plan_entitlement (plan_key, entitlement_key, enabled)
select p.key, 'cap.studio', true
from public.plan p
where p.key in ('free', 'starter', 'growth', 'business');

comment on table public.studio_node is
  'H25: one typed element of the living planning model. Linked nodes (record_type/record_id) copy NOTHING — the service resolves canonical fields at read time.';
comment on table public.studio_scenario_change is
  'H25: scenario overlay values. Canonical records are untouched until an authorized APPLY replays record-changes through the owning services.';
