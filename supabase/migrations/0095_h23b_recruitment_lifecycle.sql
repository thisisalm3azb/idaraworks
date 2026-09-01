-- ═════════════════════════════════════════════════════════════════════════════
-- H23B — recruitment pipeline, offboarding, and the approval vocabulary H23
-- will need. One migration so the subject_type CHECK is widened exactly once.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── the approval engine learns H23's subjects ────────────────────────────────
-- Same 0091 pattern: full cumulative list, both constraints.
alter table public.approval drop constraint if exists approval_subject_type_check;
alter table public.approval
  add constraint approval_subject_type_check check (subject_type in (
    'material_request', 'expense', 'quote_send', 'purchase_order', 'payment',
    'task_completion', 'asset_disposal',
    'leave_request', 'overtime_request', 'expense_claim', 'pay_run'
  ));
alter table public.approval_rule drop constraint if exists approval_rule_subject_type_check;
alter table public.approval_rule
  add constraint approval_rule_subject_type_check check (subject_type in (
    'material_request', 'expense', 'quote_send', 'purchase_order', 'payment',
    'task_completion', 'asset_disposal',
    'leave_request', 'overtime_request', 'expense_claim', 'pay_run'
  ));

-- ── recruitment: requisition → candidate → interview → offer → employee ──────
-- Proportionate by design: enough pipeline that an accepted offer becomes an
-- employee WITHOUT retyping, and no more.

create table public.job_requisition (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null check (length(reference) <= 24),
  title text not null check (length(trim(title)) between 1 and 160),
  department_id uuid,
  position_id uuid,
  headcount integer not null default 1 check (headcount between 1 and 100),
  status text not null default 'open'
    check (status in ('open', 'on_hold', 'filled', 'cancelled')),
  notes text check (notes is null or length(notes) <= 2000),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_requisition_id_org_uq unique (id, org_id),
  constraint job_requisition_ref_uq unique (org_id, reference),
  constraint job_requisition_department_fk foreign key (department_id, org_id)
    references public.department (id, org_id) on delete restrict,
  constraint job_requisition_position_fk foreign key (position_id, org_id)
    references public.position (id, org_id) on delete restrict
);
create index job_requisition_org_idx on public.job_requisition (org_id, status);
alter table public.job_requisition enable row level security;
create policy job_requisition_all on public.job_requisition
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.job_requisition to app_user;
grant update (title, department_id, position_id, headcount, status, notes, updated_at)
  on public.job_requisition to app_user;

create table public.candidate (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  requisition_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 160),
  email text check (email is null or length(email) <= 160),
  phone text check (phone is null or length(phone) <= 32),
  cv_file_id uuid references public.file (id),
  stage text not null default 'applied'
    check (stage in ('applied', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn')),
  notes text check (notes is null or length(notes) <= 4000),
  -- Set when an accepted offer becomes an employee — the no-retyping bridge.
  hired_employee_id uuid,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint candidate_id_org_uq unique (id, org_id),
  constraint candidate_requisition_fk foreign key (requisition_id, org_id)
    references public.job_requisition (id, org_id) on delete restrict,
  constraint candidate_hired_fk foreign key (hired_employee_id, org_id)
    references public.employee (id, org_id) on delete restrict
);
create index candidate_org_req_idx on public.candidate (org_id, requisition_id, stage);
alter table public.candidate enable row level security;
create policy candidate_all on public.candidate
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.candidate to app_user;
grant update (name, email, phone, cv_file_id, stage, notes, hired_employee_id, updated_at)
  on public.candidate to app_user;

create table public.candidate_interview (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  candidate_id uuid not null,
  scheduled_at timestamptz not null,
  interviewer_employee_id uuid,
  kind text not null default 'general'
    check (kind in ('screening', 'general', 'technical', 'final')),
  outcome text check (outcome is null or outcome in ('advance', 'reject', 'hold')),
  feedback text check (feedback is null or length(feedback) <= 4000),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint candidate_interview_id_org_uq unique (id, org_id),
  constraint candidate_interview_candidate_fk foreign key (candidate_id, org_id)
    references public.candidate (id, org_id) on delete restrict,
  constraint candidate_interview_interviewer_fk foreign key (interviewer_employee_id, org_id)
    references public.employee (id, org_id) on delete restrict
);
create index candidate_interview_org_idx
  on public.candidate_interview (org_id, candidate_id, scheduled_at);
alter table public.candidate_interview enable row level security;
create policy candidate_interview_all on public.candidate_interview
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.candidate_interview to app_user;
grant update (scheduled_at, interviewer_employee_id, kind, outcome, feedback, updated_at)
  on public.candidate_interview to app_user;

-- The offer's PAY is cost-walled like every other pay figure.
create table public.candidate_offer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  candidate_id uuid not null,
  position_id uuid,
  salary_minor bigint not null check (salary_minor >= 0),
  start_date date not null,
  probation_months integer check (probation_months is null or probation_months between 0 and 6),
  status text not null default 'draft'
    check (status in ('draft', 'extended', 'accepted', 'declined', 'withdrawn')),
  notes text check (notes is null or length(notes) <= 2000),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint candidate_offer_id_org_uq unique (id, org_id),
  constraint candidate_offer_candidate_fk foreign key (candidate_id, org_id)
    references public.candidate (id, org_id) on delete restrict,
  constraint candidate_offer_position_fk foreign key (position_id, org_id)
    references public.position (id, org_id) on delete restrict
);
create unique index candidate_offer_live_uq
  on public.candidate_offer (org_id, candidate_id)
  where status in ('draft', 'extended');
alter table public.candidate_offer enable row level security;
create policy candidate_offer_all on public.candidate_offer
  for all to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()))
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select, insert on public.candidate_offer to app_user;
grant update (position_id, salary_minor, start_date, probation_months, status, notes, updated_at)
  on public.candidate_offer to app_user;

-- ── offboarding: the checklist that protects the exit ────────────────────────
-- Asset return references the H22E register READ-ONLY (a checklist row points
-- at an assignment; returning the asset itself stays the asset module's job).
create table public.offboarding_item (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  kind text not null check (kind in
    ('asset_return', 'access_revocation', 'final_settlement_inputs', 'document_handover',
     'knowledge_transfer', 'exit_interview', 'other')),
  title text not null check (length(trim(title)) between 1 and 200),
  -- For asset_return rows: which asset is still out.
  asset_id uuid,
  done_at timestamptz,
  done_by uuid references public.user_profile (id),
  note text check (note is null or length(note) <= 1000),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint offboarding_item_id_org_uq unique (id, org_id),
  constraint offboarding_item_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict,
  constraint offboarding_item_asset_fk foreign key (asset_id, org_id)
    references public.asset (id, org_id) on delete restrict
);
create index offboarding_item_org_emp_idx
  on public.offboarding_item (org_id, employee_id);
alter table public.offboarding_item enable row level security;
create policy offboarding_item_all on public.offboarding_item
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.offboarding_item to app_user;
grant update (done_at, done_by, note) on public.offboarding_item to app_user;

-- ── final settlement INPUTS (calculation itself is H23D's payroll engine) ────
create table public.final_settlement_input (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  employee_id uuid not null,
  kind text not null check (kind in
    ('unused_leave_days', 'unpaid_leave_days', 'notice_shortfall_days', 'other_addition',
     'other_deduction', 'note')),
  label text not null check (length(trim(label)) between 1 and 200),
  quantity numeric(10, 2) check (quantity is null or quantity >= 0),
  amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint final_settlement_input_id_org_uq unique (id, org_id),
  constraint final_settlement_input_employee_fk foreign key (employee_id, org_id)
    references public.employee (id, org_id) on delete restrict
);
create index final_settlement_input_org_emp_idx
  on public.final_settlement_input (org_id, employee_id);
alter table public.final_settlement_input enable row level security;
-- Settlement money is pay data: cost wall.
create policy final_settlement_input_all on public.final_settlement_input
  for all to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()))
  with check (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select, insert on public.final_settlement_input to app_user;
grant update (label, quantity, amount_minor) on public.final_settlement_input to app_user;
