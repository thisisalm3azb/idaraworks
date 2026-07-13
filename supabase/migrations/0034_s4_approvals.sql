-- 0034_s4_approvals (S4 — "Supply & Approve", part 1 of 2): the unified approval
-- engine (doc 05). approval is a FIRST-CLASS row referencing the approvable (D-5.1),
-- never a status field; the engine is the SOLE writer of both the approval and the
-- subject transition in one tx. approval_rule (D-5.2) is single-approver threshold
-- routing, template-seeded + org-editable. Forward-only.

-- ── approval_rule (D-5.2 — threshold routing; org-editable via config) ───────
-- condition vocabulary is FIXED: always | amount_gte(minor) | urgency_in(...).
-- Ambiguity (two equally-specific matches) is a CONFIG-TIME validation error in
-- the service, not a runtime resolution — no DB constraint models "most specific".
create table public.approval_rule (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  subject_type text not null check (
    subject_type in ('material_request', 'expense', 'quote_send', 'purchase_order', 'payment')
  ),
  condition_kind text not null check (condition_kind in ('always', 'amount_gte', 'urgency_in')),
  amount_gte_minor bigint check (amount_gte_minor is null or amount_gte_minor >= 0),
  urgency_in text[],
  assigned_role text not null check (
    assigned_role in ('owner', 'admin', 'manager', 'foreman', 'procurement', 'accounts', 'viewer')
  ),
  auto_approve_below_minor bigint check (auto_approve_below_minor is null or auto_approve_below_minor >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The condition kind implies which parameter must be present.
  constraint approval_rule_amount_ck check (condition_kind <> 'amount_gte' or amount_gte_minor is not null),
  constraint approval_rule_urgency_ck check (condition_kind <> 'urgency_in' or urgency_in is not null),
  constraint approval_rule_id_org_uq unique (id, org_id)
);
create index approval_rule_org_subject_idx on public.approval_rule (org_id, subject_type, active);
alter table public.approval_rule enable row level security;
create policy approval_rule_select on public.approval_rule
  for select to app_user using (org_id = (select app.current_org_id()));
-- Rules are CONFIG: only owner/admin (config.manage) may write them AT THE DB.
create policy approval_rule_insert on public.approval_rule
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin')
  );
create policy approval_rule_update on public.approval_rule
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin')
  )
  with check (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin')
  );
grant select, insert on public.approval_rule to app_user;
grant update (subject_type, condition_kind, amount_gte_minor, urgency_in, assigned_role,
  auto_approve_below_minor, active, updated_at) on public.approval_rule to app_user;
-- No DELETE — deactivate via active=false (no-hard-delete invariant, D-1.7).

-- ── approval (D-5.1 — first-class decision record) ───────────────────────────
create table public.approval (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  subject_type text not null check (
    subject_type in ('material_request', 'expense', 'quote_send', 'purchase_order', 'payment')
  ),
  subject_id uuid not null,
  -- Denormalised summary (D-1.6): { title, amount_minor?, jobRef? }. amount_minor
  -- is COST data — redacted at the serialization boundary for non-finance viewers
  -- (F-23), including notification bodies. Stored here so the inbox renders without
  -- loading subjects.
  subject_summary jsonb not null,
  rule_id uuid references public.approval_rule (id),
  requested_by uuid not null references public.user_profile (id),
  assigned_role text not null check (
    assigned_role in ('owner', 'admin', 'manager', 'foreman', 'procurement', 'accounts', 'viewer')
  ),
  assigned_user_id uuid references public.user_profile (id),
  state text not null default 'pending'
    check (state in ('pending', 'approved', 'rejected', 'withdrawn', 'superseded')),
  decided_by uuid references public.user_profile (id),
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 2000),
  self_approved boolean not null default false,
  expires_hint timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A rejection ALWAYS carries a reason (doc 05).
  constraint approval_reject_reason_ck check (state <> 'rejected' or decision_note is not null),
  -- A decided-implying state must record its decider (the sole-writer contract).
  constraint approval_decided_ck check (
    state in ('pending', 'withdrawn') or decided_by is not null
  ),
  constraint approval_id_org_uq unique (id, org_id)
);
-- The inbox hot path: open approvals for a role (partial index — doc 11 DB note).
create index approval_pending_role_idx on public.approval (org_id, assigned_role)
  where state = 'pending';
-- Find the (single) live approval for a subject.
create index approval_subject_idx on public.approval (org_id, subject_type, subject_id);
alter table public.approval enable row level security;
create policy approval_select on public.approval
  for select to app_user using (org_id = (select app.current_org_id()));
-- Author backstop: the requester is the caller (the engine sets requested_by=ctx).
create policy approval_insert on public.approval
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and requested_by = (select app.current_user_id())
  );
-- DECIDER path: an approvals.decide archetype transitions a PENDING approval; the
-- rule-scope (assigned_role ∈ my roles) is the SERVICE gate. USING pins the current
-- row to pending; CHECK requires the resulting decided state to record a decider.
create policy approval_decide_update on public.approval
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin', 'manager', 'accounts')
    and state = 'pending'
  )
  with check (
    org_id = (select app.current_org_id())
    and state in ('approved', 'rejected')
    and decided_by is not null
  );
-- REQUESTER withdraw: only the requester, only while pending, only → withdrawn.
create policy approval_withdraw_update on public.approval
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and requested_by = (select app.current_user_id())
    and state = 'pending'
  )
  with check (org_id = (select app.current_org_id()) and state = 'withdrawn');
grant select, insert on public.approval to app_user;
grant update (state, decided_by, decided_at, decision_note, self_approved, updated_at)
  on public.approval to app_user;
-- No DELETE — approvals are the decision audit record.
