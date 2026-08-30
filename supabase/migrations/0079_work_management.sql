-- 0079_work_management (H21 — adaptive work: lifecycle, phases, tasks,
-- dependencies, scheduling, operational approvals).
--
-- The canonical work record is the EXISTING public.job. Sixteen tables are
-- already pinned to job (id, org_id); job_stage is already a snapshotted phase
-- model; task and job_crew already exist. This migration EVOLVES them and adds
-- only what genuinely has no representation today:
--   * job          — owner, priority, location, description, lifecycle reasons,
--                    origin and the missing source-opportunity link
--   * job_stage    — the phase_semantic snapshot (engine predicates could not be
--                    evaluated per job because only the template carried it)
--   * task         — the fields a real micro-step needs, plus three lifecycle
--                    states (ready / blocked / awaiting_approval)
--   * task_dependency — NEW. No dependency model existed anywhere.
--   * approval     — one new subject_type: task_completion
--
-- Reason CHECKs are added NOT VALID on purpose: they must govern every future
-- write without retroactively invalidating rows that predate the rule (real
-- organizations already hold on-hold and cancelled work). No DELETE grants.

-- ── job → the full work record ──────────────────────────────────────────────
alter table public.job
  -- The accountable owner. manager_user_id/foreman_user_id stay exactly as they
  -- are (assignment scope reads them); owner is the single "who answers for
  -- this work" field the other domains already have (lead/opportunity.owner_user_id).
  add column owner_user_id uuid references public.user_profile (id),
  add column priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  add column location text check (location is null or length(location) <= 200),
  add column description text check (description is null or length(description) <= 4000),
  -- Lifecycle reasons. Structural meaning lives in status_category; these say WHY.
  add column on_hold_reason text check (on_hold_reason is null or length(on_hold_reason) between 1 and 500),
  add column cancellation_reason text
    check (cancellation_reason is null or length(cancellation_reason) between 1 and 500),
  -- How this work came to exist. 'quotation' keeps its link on quote.converted_job_id
  -- (the existing canonical direction); 'opportunity' needs the new column below.
  add column origin text not null default 'direct'
    check (origin in ('quotation', 'opportunity', 'direct')),
  add column source_opportunity_id uuid,
  add column archived_at timestamptz,
  add column archived_by uuid references public.user_profile (id);

-- Work started from a won opportunity WITHOUT a quotation (H21 Part J.2).
alter table public.job
  add constraint job_source_opportunity_org_fk
  foreign key (source_opportunity_id, org_id)
  references public.opportunity (id, org_id);

-- A held or cancelled job must say why. NOT VALID: governs writes from now on,
-- never retroactively invalidates existing rows.
alter table public.job
  add constraint job_hold_reason_ck
  check (status_category <> 'on_hold' or on_hold_reason is not null) not valid;
alter table public.job
  add constraint job_cancel_reason_ck
  check (status_category <> 'cancelled' or cancellation_reason is not null) not valid;

create index job_org_owner_idx on public.job (org_id, owner_user_id)
  where archived = false;
-- One work record per opportunity, enforced structurally: two people pressing
-- "Start work" at the same moment cannot produce two jobs.
create unique index job_org_opportunity_uq on public.job (org_id, source_opportunity_id)
  where source_opportunity_id is not null;
-- The work hub's default sort surface: open work by priority then target date.
create index job_org_open_idx on public.job (org_id, status_category, priority, due_date)
  where archived = false;

grant update (owner_user_id, priority, location, description, on_hold_reason,
              cancellation_reason, origin, source_opportunity_id, archived_at, archived_by)
  on public.job to app_user;

-- ── job_stage → snapshot the phase semantic ─────────────────────────────────
-- The template always carried phase_semantic but the job's own stage rows did
-- not, so isReportable()/isPreFinal() could not be evaluated from a job. It is
-- a SNAPSHOT like stage_key/name/weight/sort — deliberately NOT in the grant.
alter table public.job_stage
  add column phase_semantic text
    check (phase_semantic is null or
           phase_semantic in ('preparation', 'production', 'finishing', 'verification', 'handover'));

-- ── task → a real micro-step ────────────────────────────────────────────────
-- Existing status values are preserved exactly ('pending' remains the
-- not-started key — stable keys never churn; the LABEL reads "Not started").
alter table public.task drop constraint task_status_check;
alter table public.task
  add constraint task_status_check check (status in (
    'pending',           -- not started
    'ready',             -- dependencies satisfied, may begin
    'in_progress',
    'blocked',           -- explained by blocked_reason
    'awaiting_approval', -- a task_completion approval is pending
    'completed',
    'cancelled'
  ));

alter table public.task
  add column description text check (description is null or length(description) <= 4000),
  add column priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  add column start_date date,
  add column completed_at timestamptz,
  add column estimated_minutes integer
    check (estimated_minutes is null or (estimated_minutes >= 0 and estimated_minutes <= 100000)),
  add column actual_minutes integer
    check (actual_minutes is null or (actual_minutes >= 0 and actual_minutes <= 100000)),
  -- Parent/child micro-steps. Depth is bounded in the service (2 levels) so the
  -- tree stays comprehensible and every read stays a bounded join.
  add column parent_task_id uuid,
  add column blocked_reason text check (blocked_reason is null or length(blocked_reason) between 1 and 500),
  add column requires_approval boolean not null default false,
  add column updated_by uuid references public.user_profile (id),
  add column archived boolean not null default false;

-- The composite pin must exist before anything references it (including the
-- self-referencing parent FK below and task_dependency's two FKs).
alter table public.task add constraint task_id_org_uq unique (id, org_id);
alter table public.task
  add constraint task_parent_org_fk foreign key (parent_task_id, org_id)
  references public.task (id, org_id);
-- A blocked task always explains itself (NOT VALID — governs writes onward).
alter table public.task
  add constraint task_blocked_reason_ck
  check (status <> 'blocked' or blocked_reason is not null) not valid;
-- A task is never its own parent.
alter table public.task
  add constraint task_parent_not_self_ck check (parent_task_id is null or parent_task_id <> id);

create index task_org_assignee_idx on public.task (org_id, assignee_employee_id, status)
  where archived = false;
create index task_org_parent_idx on public.task (org_id, parent_task_id)
  where parent_task_id is not null;
create index task_org_stage_idx on public.task (org_id, stage_id)
  where stage_id is not null;

grant update (description, priority, start_date, completed_at, estimated_minutes,
              actual_minutes, parent_task_id, blocked_reason, requires_approval,
              updated_by, archived)
  on public.task to app_user;

-- ── task_dependency (NEW — nothing represented this) ────────────────────────
-- "task_id cannot proceed until depends_on_task_id is finished." Both ends are
-- pinned to the same organization AND validated to the same work in the service.
-- Removal is SOFT (removed_at) exactly like job_crew: relationships that shaped
-- a decision stay auditable. No DELETE grant.
create table public.task_dependency (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  task_id uuid not null,
  depends_on_task_id uuid not null,
  kind text not null default 'finish_to_start'
    check (kind in ('finish_to_start', 'blocks')),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references public.user_profile (id),
  constraint task_dependency_task_org_fk foreign key (task_id, org_id)
    references public.task (id, org_id),
  constraint task_dependency_upstream_org_fk foreign key (depends_on_task_id, org_id)
    references public.task (id, org_id),
  constraint task_dependency_not_self_ck check (task_id <> depends_on_task_id)
);
-- One LIVE edge per ordered pair; historical (removed) edges are unconstrained
-- so a dependency may be removed and later re-added.
create unique index task_dependency_live_uq
  on public.task_dependency (org_id, task_id, depends_on_task_id)
  where removed_at is null;
-- Downstream traversal ("what does this block?") and upstream readiness.
create index task_dependency_upstream_idx
  on public.task_dependency (org_id, depends_on_task_id) where removed_at is null;
create index task_dependency_task_idx
  on public.task_dependency (org_id, task_id) where removed_at is null;

alter table public.task_dependency enable row level security;
create policy task_dependency_select on public.task_dependency
  for select to app_user using (org_id = (select app.current_org_id()));
create policy task_dependency_insert on public.task_dependency
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and created_by = (select app.current_user_id())
  );
create policy task_dependency_update on public.task_dependency
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.task_dependency to app_user;
grant update (removed_at, removed_by) on public.task_dependency to app_user;

-- ── approvals → one new operational subject ─────────────────────────────────
-- Task completion is the only H21 flow with no first-class equivalent already:
-- phase completion is served by job_stage.completion_requested_by + completeStage,
-- and reopening completed work is an authorized command with a required reason.
alter table public.approval drop constraint approval_subject_type_check;
alter table public.approval
  add constraint approval_subject_type_check check (subject_type in (
    'material_request', 'expense', 'quote_send', 'purchase_order', 'payment',
    'task_completion'
  ));
alter table public.approval_rule drop constraint approval_rule_subject_type_check;
alter table public.approval_rule
  add constraint approval_rule_subject_type_check check (subject_type in (
    'material_request', 'expense', 'quote_send', 'purchase_order', 'payment',
    'task_completion'
  ));

comment on column public.job.origin is
  'H21: how this work came to exist. quotation links via quote.converted_job_id; opportunity via source_opportunity_id; direct has no sales record.';
comment on table public.task_dependency is
  'H21: "task_id waits for depends_on_task_id". Cycles are rejected in the service; removal is soft.';
