-- 0116_h26d_workflow_runs (H26 — workflow runs above the approvals engine,
-- ADR-22).
--
-- A run COPIES its workflow definition, so editing the workflow never changes
-- a run in flight. Each step run is its own approval subject
-- (`document_step`, subject id = the step run row): that keeps the engine's
-- one-live-approval-per-subject law intact for parallel approvers, and lets
-- the existing inbox, notifications, self-approval guard and decide screen
-- carry document approvals unchanged.

-- ── the approval subject ─────────────────────────────────────────────────────
alter table public.approval drop constraint approval_subject_type_check;
alter table public.approval
  add constraint approval_subject_type_check check (subject_type in (
    'material_request', 'expense', 'quote_send', 'purchase_order', 'payment',
    'task_completion', 'asset_disposal', 'leave_request', 'overtime_request',
    'expense_claim', 'pay_run', 'journal_entry', 'scenario_apply', 'document_step'
  ));
alter table public.approval_rule drop constraint approval_rule_subject_type_check;
alter table public.approval_rule
  add constraint approval_rule_subject_type_check check (subject_type in (
    'material_request', 'expense', 'quote_send', 'purchase_order', 'payment',
    'task_completion', 'asset_disposal', 'leave_request', 'overtime_request',
    'expense_claim', 'pay_run', 'journal_entry', 'scenario_apply', 'document_step'
  ));

-- ── runs ─────────────────────────────────────────────────────────────────────
create table public.doc_workflow_run (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  document_id uuid not null,
  -- The frozen revision under review; issue refuses if the document moved on.
  revision_id uuid not null,
  workflow_id uuid,
  definition jsonb not null,
  status text not null default 'running' check (status in (
    'running', 'completed', 'rejected', 'cancelled'
  )),
  current_step_index integer not null default 0 check (current_step_index >= 0),
  requires_signature boolean not null default false,
  outcome_note text check (outcome_note is null or length(outcome_note) <= 2000),
  started_by uuid not null references public.user_profile (id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  row_version bigint not null default 1,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint doc_workflow_run_id_org_uq unique (id, org_id),
  constraint doc_workflow_run_document_fk foreign key (document_id, org_id)
    references public.doc_document (id, org_id) on delete restrict,
  constraint doc_workflow_run_revision_fk foreign key (revision_id, org_id)
    references public.doc_revision (id, org_id) on delete restrict,
  constraint doc_workflow_run_workflow_fk foreign key (workflow_id, org_id)
    references public.doc_workflow (id, org_id) on delete restrict,
  constraint doc_workflow_run_finished_ck
    check ((status = 'running') = (finished_at is null))
);
create unique index doc_workflow_run_one_running_idx on public.doc_workflow_run (document_id)
  where status = 'running';
create index doc_workflow_run_org_idx on public.doc_workflow_run (org_id, document_id, started_at desc);
alter table public.doc_workflow_run enable row level security;
create policy doc_workflow_run_select on public.doc_workflow_run
  for select to app_user using (org_id = (select app.current_org_id()));
create policy doc_workflow_run_insert on public.doc_workflow_run
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy doc_workflow_run_update on public.doc_workflow_run
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.doc_workflow_run to app_user;
grant update (status, current_step_index, requires_signature, outcome_note, finished_at,
              row_version, updated_at)
  on public.doc_workflow_run to app_user;

-- ── step runs: one per (step, assignee) ──────────────────────────────────────
create table public.doc_workflow_step_run (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  run_id uuid not null,
  document_id uuid not null,
  step_id text not null check (step_id ~ '^[A-Za-z0-9_-]{1,40}$'),
  step_index integer not null check (step_index >= 0),
  kind text not null check (kind in ('review', 'approval', 'signature')),
  -- `active` is the live status the approvals engine guards on; it moves the
  -- row to completed / rejected / cancelled itself.
  status text not null default 'pending' check (status in (
    'pending', 'active', 'completed', 'rejected', 'skipped', 'cancelled'
  )),
  assignee_user_id uuid references public.user_profile (id),
  assignee_archetype text check (assignee_archetype is null or assignee_archetype in (
    'owner', 'admin', 'manager', 'foreman', 'procurement', 'accounts', 'viewer'
  )),
  approval_id uuid,
  due_at timestamptz,
  decided_by uuid references public.user_profile (id),
  decided_at timestamptz,
  decision text check (decision is null or decision in ('approved', 'rejected')),
  note text check (note is null or length(note) <= 2000),
  delegated_from uuid references public.user_profile (id),
  escalated_at timestamptz,
  row_version bigint not null default 1,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint doc_workflow_step_run_id_org_uq unique (id, org_id),
  constraint doc_workflow_step_run_run_fk foreign key (run_id, org_id)
    references public.doc_workflow_run (id, org_id) on delete restrict,
  constraint doc_workflow_step_run_document_fk foreign key (document_id, org_id)
    references public.doc_document (id, org_id) on delete restrict,
  constraint doc_workflow_step_run_approval_fk foreign key (approval_id, org_id)
    references public.approval (id, org_id) on delete restrict
);
create index doc_workflow_step_run_run_idx on public.doc_workflow_step_run (org_id, run_id, step_index);
create index doc_workflow_step_run_assignee_idx on public.doc_workflow_step_run (org_id, assignee_user_id)
  where status = 'active';
create index doc_workflow_step_run_due_idx on public.doc_workflow_step_run (org_id, due_at)
  where status = 'active';
alter table public.doc_workflow_step_run enable row level security;
create policy doc_workflow_step_run_select on public.doc_workflow_step_run
  for select to app_user using (org_id = (select app.current_org_id()));
create policy doc_workflow_step_run_insert on public.doc_workflow_step_run
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy doc_workflow_step_run_update on public.doc_workflow_step_run
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.doc_workflow_step_run to app_user;
grant update (status, assignee_user_id, assignee_archetype, approval_id, due_at, decided_by,
              decided_at, decision, note, delegated_from, escalated_at, row_version, updated_at)
  on public.doc_workflow_step_run to app_user;

create trigger doc_workflow_run_touch before update on public.doc_workflow_run
  for each row execute function app.set_updated_at();
create trigger doc_workflow_step_run_touch before update on public.doc_workflow_step_run
  for each row execute function app.set_updated_at();

comment on table public.doc_workflow_run is
  'H26: one governed pass of a document through its workflow. The definition is copied at start; step runs are approval subjects (document_step).';
