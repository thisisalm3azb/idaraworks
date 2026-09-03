-- H28B — conversations, messages, runs (parent/child graph), steps, actions
-- with previews and confirmation, governed memory, custom agents with
-- versions, per-organisation agent state, saved outputs, proactive schedules
-- and per-person schedule preferences (docs/H28-TRUTH-MAP.md ADR-57..62, 65).
-- Widens the approval subject checks with 'ai_action'. Additive only; every
-- surface stays behind FEATURE_IDARA_INTELLIGENCE.

-- ── conversations (private to the person who owns them) ────────────────────
create table public.ai_conversation (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  user_id uuid not null references public.user_profile (id),
  title text not null check (length(title) between 1 and 200),
  kind text not null default 'quick' check (kind in ('quick', 'session', 'task', 'schedule')),
  agent_id text not null default 'idara' check (length(agent_id) <= 40),
  status text not null default 'active' check (status in ('active', 'archived')),
  -- Records the person chose to share: [{type, id, label}] (never the whole organisation).
  context_refs jsonb not null default '[]'::jsonb,
  branched_from_conversation_id uuid,
  branched_from_seq integer,
  message_count integer not null default 0 check (message_count >= 0),
  last_run_id uuid,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_conversation_id_org_uq unique (id, org_id)
);
create index ai_conversation_user_idx on public.ai_conversation (org_id, user_id, status, last_activity_at desc);
alter table public.ai_conversation enable row level security;
create policy ai_conversation_select on public.ai_conversation
  for select to app_user using (org_id = (select app.current_org_id()) and user_id = (select app.current_user_id()));
create policy ai_conversation_insert on public.ai_conversation
  for insert to app_user with check (org_id = (select app.current_org_id()) and user_id = (select app.current_user_id()));
create policy ai_conversation_update on public.ai_conversation
  for update to app_user using (org_id = (select app.current_org_id()) and user_id = (select app.current_user_id()))
  with check (org_id = (select app.current_org_id()) and user_id = (select app.current_user_id()));
grant select, insert on public.ai_conversation to app_user;
grant update (title, kind, agent_id, status, context_refs, message_count, last_run_id, last_activity_at, updated_at)
  on public.ai_conversation to app_user;
create trigger ai_conversation_touch before update on public.ai_conversation
  for each row execute function app.set_updated_at();

-- ── messages (immutable; structured blocks, evidence and provenance) ────────
create table public.ai_message (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  conversation_id uuid not null,
  seq integer not null check (seq >= 1),
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  agent_id text check (agent_id is null or length(agent_id) <= 40),
  -- Structured content: [{kind:'text'|'evidence'|'actions'|'table'|'chart'|'comparison'|'timeline'|'notice', ...}]
  blocks jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  run_id uuid,
  -- Who answered and who contributed: {answeredBy, contributors:[], provider, model, kind:'answer'|'suggestion'|'draft'|'proposed_action'|'refusal'}
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ai_message_id_org_uq unique (id, org_id),
  constraint ai_message_conversation_fk foreign key (conversation_id, org_id)
    references public.ai_conversation (id, org_id) on delete restrict,
  constraint ai_message_seq_uq unique (conversation_id, seq)
);
create index ai_message_conversation_idx on public.ai_message (org_id, conversation_id, seq);
alter table public.ai_message enable row level security;
create policy ai_message_select on public.ai_message
  for select to app_user using (
    org_id = (select app.current_org_id())
    and exists (select 1 from public.ai_conversation c
                where c.id = ai_message.conversation_id and c.org_id = ai_message.org_id
                  and c.user_id = (select app.current_user_id())));
create policy ai_message_insert on public.ai_message
  for insert to app_user with check (
    org_id = (select app.current_org_id())
    and exists (select 1 from public.ai_conversation c
                where c.id = ai_message.conversation_id and c.org_id = ai_message.org_id
                  and c.user_id = (select app.current_user_id())));
grant select, insert on public.ai_message to app_user;

-- ── runs: the parent/child execution graph ──────────────────────────────────
create table public.ai_run (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  conversation_id uuid,
  parent_run_id uuid,
  root_run_id uuid not null,
  depth integer not null default 0 check (depth between 0 and 4),
  agent_id text not null check (length(agent_id) <= 40),
  agent_version integer not null default 1,
  custom_agent_id uuid,
  kind text not null default 'interactive' check (kind in ('interactive', 'background', 'schedule', 'delegation', 'eval')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'waiting_approval', 'paused', 'cancelled', 'completed', 'failed')),
  requested_by uuid not null references public.user_profile (id),
  input_text text not null default '' check (length(input_text) <= 8000),
  context_refs jsonb not null default '[]'::jsonb,
  plan jsonb not null default '[]'::jsonb,
  route jsonb not null default '{}'::jsonb,
  tool_calls integer not null default 0 check (tool_calls >= 0),
  child_count integer not null default 0 check (child_count >= 0),
  credits integer not null default 0 check (credits >= 0),
  est_cost_micros bigint not null default 0 check (est_cost_micros >= 0),
  error text check (error is null or length(error) <= 1000),
  idempotency_key text check (idempotency_key is null or length(idempotency_key) <= 120),
  cancel_requested_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_run_id_org_uq unique (id, org_id),
  constraint ai_run_idem_uq unique (org_id, idempotency_key)
);
create index ai_run_user_idx on public.ai_run (org_id, requested_by, created_at desc);
create index ai_run_root_idx on public.ai_run (org_id, root_run_id);
create index ai_run_queue_idx on public.ai_run (status, created_at) where status = 'queued';
alter table public.ai_run enable row level security;
create policy ai_run_select on public.ai_run
  for select to app_user using (org_id = (select app.current_org_id()) and requested_by = (select app.current_user_id()));
create policy ai_run_insert on public.ai_run
  for insert to app_user with check (org_id = (select app.current_org_id()) and requested_by = (select app.current_user_id()));
create policy ai_run_update on public.ai_run
  for update to app_user using (org_id = (select app.current_org_id()) and requested_by = (select app.current_user_id()))
  with check (org_id = (select app.current_org_id()) and requested_by = (select app.current_user_id()));
grant select, insert on public.ai_run to app_user;
grant update (status, plan, route, tool_calls, child_count, credits, est_cost_micros, error, cancel_requested_at,
              started_at, finished_at, updated_at)
  on public.ai_run to app_user;
create trigger ai_run_touch before update on public.ai_run
  for each row execute function app.set_updated_at();

-- ── run steps: the visible execution trace ──────────────────────────────────
create table public.ai_run_step (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  run_id uuid not null,
  seq integer not null check (seq >= 1),
  kind text not null check (kind in ('plan', 'route', 'tool', 'model', 'delegate', 'approval', 'note', 'flag', 'action', 'memory')),
  status text not null default 'completed' check (status in ('running', 'completed', 'failed', 'skipped')),
  tool_id text check (tool_id is null or length(tool_id) <= 80),
  agent_id text check (agent_id is null or length(agent_id) <= 40),
  input_summary jsonb not null default '{}'::jsonb,
  output_summary jsonb not null default '{}'::jsonb,
  records jsonb not null default '[]'::jsonb,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  interaction_id uuid,
  child_run_id uuid,
  summary text check (summary is null or length(summary) <= 2000),
  created_at timestamptz not null default now(),
  constraint ai_run_step_id_org_uq unique (id, org_id),
  constraint ai_run_step_run_fk foreign key (run_id, org_id) references public.ai_run (id, org_id) on delete restrict,
  constraint ai_run_step_seq_uq unique (run_id, seq)
);
create index ai_run_step_run_idx on public.ai_run_step (org_id, run_id, seq);
alter table public.ai_run_step enable row level security;
create policy ai_run_step_select on public.ai_run_step
  for select to app_user using (
    org_id = (select app.current_org_id())
    and exists (select 1 from public.ai_run r where r.id = ai_run_step.run_id and r.org_id = ai_run_step.org_id
                  and r.requested_by = (select app.current_user_id())));
create policy ai_run_step_insert on public.ai_run_step
  for insert to app_user with check (
    org_id = (select app.current_org_id())
    and exists (select 1 from public.ai_run r where r.id = ai_run_step.run_id and r.org_id = ai_run_step.org_id
                  and r.requested_by = (select app.current_user_id())));
create policy ai_run_step_update on public.ai_run_step
  for update to app_user using (
    org_id = (select app.current_org_id())
    and exists (select 1 from public.ai_run r where r.id = ai_run_step.run_id and r.org_id = ai_run_step.org_id
                  and r.requested_by = (select app.current_user_id())))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.ai_run_step to app_user;
grant update (status, output_summary, records, latency_ms, interaction_id, child_run_id, summary)
  on public.ai_run_step to app_user;

-- ── actions: preview, confirmation, approval, execution ─────────────────────
create table public.ai_action (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  run_id uuid not null,
  conversation_id uuid,
  tool_id text not null check (length(tool_id) <= 80),
  risk_class integer not null check (risk_class between 1 and 5),
  title text not null check (length(title) between 1 and 200),
  -- {what, records:[{type,id,label}], changes:[{field, from, to}], permission, external:[...], estCredits, reversible, sideEffects:[...]}
  preview jsonb not null default '{}'::jsonb,
  input jsonb not null default '{}'::jsonb,
  -- Versions of the records seen when the preview was built; drift refuses execution.
  record_versions jsonb not null default '[]'::jsonb,
  status text not null default 'proposed'
    check (status in ('proposed', 'confirmed', 'awaiting_approval', 'approved', 'executing', 'executed',
                      'failed', 'refused_drift', 'cancelled', 'expired', 'rejected')),
  approval_id uuid,
  idempotency_key text not null check (length(idempotency_key) between 1 and 120),
  requested_by uuid not null references public.user_profile (id),
  confirmed_by uuid references public.user_profile (id),
  confirmed_at timestamptz,
  executed_at timestamptz,
  result jsonb,
  error text check (error is null or length(error) <= 1000),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_action_id_org_uq unique (id, org_id),
  constraint ai_action_run_fk foreign key (run_id, org_id) references public.ai_run (id, org_id) on delete restrict,
  constraint ai_action_approval_fk foreign key (approval_id, org_id) references public.approval (id, org_id) on delete restrict,
  constraint ai_action_idem_uq unique (org_id, idempotency_key)
);
create index ai_action_org_idx on public.ai_action (org_id, status, created_at desc);
create index ai_action_run_idx on public.ai_action (org_id, run_id);
alter table public.ai_action enable row level security;
create policy ai_action_select on public.ai_action
  for select to app_user using (org_id = (select app.current_org_id()));
create policy ai_action_insert on public.ai_action
  for insert to app_user with check (org_id = (select app.current_org_id()) and requested_by = (select app.current_user_id()));
create policy ai_action_update on public.ai_action
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.ai_action to app_user;
grant update (status, approval_id, confirmed_by, confirmed_at, executed_at, result, error, updated_at)
  on public.ai_action to app_user;
create trigger ai_action_touch before update on public.ai_action
  for each row execute function app.set_updated_at();

-- ── memory: explicit, governed, inspectable, revocable ──────────────────────
create table public.ai_memory (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  scope text not null check (scope in ('user', 'org')),
  user_id uuid references public.user_profile (id),
  kind text not null check (kind in ('preference', 'knowledge')),
  key text not null check (key ~ '^[a-z0-9_.-]{1,80}$'),
  value jsonb not null,
  source text check (source is null or length(source) <= 200),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.user_profile (id),
  constraint ai_memory_id_org_uq unique (id, org_id),
  constraint ai_memory_scope_user_ck check ((scope = 'user') = (user_id is not null))
);
create unique index ai_memory_live_uq on public.ai_memory (org_id, scope, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
  where revoked_at is null;
alter table public.ai_memory enable row level security;
create policy ai_memory_select on public.ai_memory
  for select to app_user using (
    org_id = (select app.current_org_id())
    and (scope = 'org' or user_id = (select app.current_user_id())));
create policy ai_memory_insert on public.ai_memory
  for insert to app_user with check (
    org_id = (select app.current_org_id())
    and ((scope = 'user' and user_id = (select app.current_user_id()))
         or (scope = 'org' and (select app.current_archetype()) in ('owner', 'admin'))));
create policy ai_memory_update on public.ai_memory
  for update to app_user using (
    org_id = (select app.current_org_id())
    and ((scope = 'user' and user_id = (select app.current_user_id()))
         or (scope = 'org' and (select app.current_archetype()) in ('owner', 'admin'))))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.ai_memory to app_user;
grant update (value, source, updated_at, revoked_at, revoked_by) on public.ai_memory to app_user;
create trigger ai_memory_touch before update on public.ai_memory
  for each row execute function app.set_updated_at();

-- ── custom agents (organisation-authored, versioned, never widening) ────────
create table public.ai_agent (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  key text not null check (key ~ '^[a-z0-9_]{2,40}$'),
  base_agent_id text not null check (length(base_agent_id) <= 40),
  name_en text not null check (length(name_en) between 1 and 80),
  name_ar text not null check (length(name_ar) between 1 and 80),
  description_en text check (description_en is null or length(description_en) <= 500),
  description_ar text check (description_ar is null or length(description_ar) <= 500),
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  published_version integer,
  -- Draft definition: {instructions, knowledgeSources[], allowedTools[], requiredApprovals[], availabilityRoles[], costCeilingCredits, modelsAllowed[], evalRequired}
  draft jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_agent_id_org_uq unique (id, org_id),
  constraint ai_agent_key_uq unique (org_id, key)
);
alter table public.ai_agent enable row level security;
create policy ai_agent_select on public.ai_agent
  for select to app_user using (org_id = (select app.current_org_id()));
create policy ai_agent_insert on public.ai_agent
  for insert to app_user with check (org_id = (select app.current_org_id()) and (select app.current_archetype()) in ('owner', 'admin'));
create policy ai_agent_update on public.ai_agent
  for update to app_user using (org_id = (select app.current_org_id()) and (select app.current_archetype()) in ('owner', 'admin'))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.ai_agent to app_user;
grant update (name_en, name_ar, description_en, description_ar, status, published_version, draft, updated_at)
  on public.ai_agent to app_user;
create trigger ai_agent_touch before update on public.ai_agent
  for each row execute function app.set_updated_at();

create table public.ai_agent_version (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  agent_id uuid not null,
  version integer not null check (version >= 1),
  snapshot jsonb not null,
  eval_version text check (eval_version is null or length(eval_version) <= 40),
  eval_passed boolean,
  eval_result jsonb,
  published_at timestamptz,
  published_by uuid references public.user_profile (id),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint ai_agent_version_id_org_uq unique (id, org_id),
  constraint ai_agent_version_agent_fk foreign key (agent_id, org_id) references public.ai_agent (id, org_id) on delete restrict,
  constraint ai_agent_version_uq unique (agent_id, version)
);
alter table public.ai_agent_version enable row level security;
create policy ai_agent_version_select on public.ai_agent_version
  for select to app_user using (org_id = (select app.current_org_id()));
create policy ai_agent_version_insert on public.ai_agent_version
  for insert to app_user with check (org_id = (select app.current_org_id()) and (select app.current_archetype()) in ('owner', 'admin'));
-- Versions are immutable evidence.
grant select, insert on public.ai_agent_version to app_user;

-- ── per-organisation agent state (platform agents on or off) ────────────────
create table public.ai_agent_state (
  org_id uuid not null references public.org (id) on delete restrict,
  agent_id text not null check (length(agent_id) <= 40),
  enabled boolean not null default true,
  reason text check (reason is null or length(reason) <= 500),
  set_by uuid references public.user_profile (id),
  set_at timestamptz not null default now(),
  primary key (org_id, agent_id)
);
alter table public.ai_agent_state enable row level security;
create policy ai_agent_state_select on public.ai_agent_state
  for select to app_user using (org_id = (select app.current_org_id()));
create policy ai_agent_state_insert on public.ai_agent_state
  for insert to app_user with check (org_id = (select app.current_org_id()) and (select app.current_archetype()) in ('owner', 'admin'));
create policy ai_agent_state_update on public.ai_agent_state
  for update to app_user using (org_id = (select app.current_org_id()) and (select app.current_archetype()) in ('owner', 'admin'))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.ai_agent_state to app_user;
grant update (enabled, reason, set_by, set_at) on public.ai_agent_state to app_user;

-- ── saved outputs (explicit saves keep sources, time, agent and approval state) ─
create table public.ai_saved_output (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  run_id uuid,
  message_id uuid,
  kind text not null check (kind in ('task_draft', 'document_draft', 'report', 'scenario', 'analysis', 'automation_proposal', 'meeting_brief')),
  title text not null check (length(title) between 1 and 200),
  content jsonb not null default '{}'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  agent_id text not null check (length(agent_id) <= 40),
  agent_version integer not null default 1,
  approval_status text not null default 'none' check (approval_status in ('none', 'pending', 'approved', 'rejected')),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_saved_output_id_org_uq unique (id, org_id)
);
create index ai_saved_output_org_idx on public.ai_saved_output (org_id, kind, created_at desc);
alter table public.ai_saved_output enable row level security;
create policy ai_saved_output_select on public.ai_saved_output
  for select to app_user using (org_id = (select app.current_org_id()));
create policy ai_saved_output_insert on public.ai_saved_output
  for insert to app_user with check (org_id = (select app.current_org_id()) and created_by = (select app.current_user_id()));
create policy ai_saved_output_update on public.ai_saved_output
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.ai_saved_output to app_user;
grant update (approval_status, updated_at) on public.ai_saved_output to app_user;
create trigger ai_saved_output_touch before update on public.ai_saved_output
  for each row execute function app.set_updated_at();

-- ── proactive schedules (a schedule of agent runs, not a rule engine) ───────
create table public.ai_schedule (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  kind text not null check (kind in (
    'management_briefing', 'stalled_opportunities', 'project_risk_digest', 'renewal_reminders',
    'missing_evidence', 'stock_reorder_proposal', 'variance_alert', 'payroll_input_reminder', 'meeting_brief')),
  agent_id text not null check (length(agent_id) <= 40),
  cadence text not null default 'daily' check (cadence in ('daily', 'weekly')),
  hour_local integer not null default 8 check (hour_local between 0 and 23),
  weekday integer check (weekday is null or weekday between 0 and 6),
  recipients jsonb not null default '["owner","admin","manager"]'::jsonb,
  enabled boolean not null default false,
  dedup_window_hours integer not null default 24 check (dedup_window_hours between 1 and 720),
  last_run_at timestamptz,
  last_content_hash text check (last_content_hash is null or length(last_content_hash) <= 64),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_schedule_id_org_uq unique (id, org_id),
  constraint ai_schedule_kind_uq unique (org_id, kind)
);
alter table public.ai_schedule enable row level security;
create policy ai_schedule_select on public.ai_schedule
  for select to app_user using (org_id = (select app.current_org_id()));
create policy ai_schedule_insert on public.ai_schedule
  for insert to app_user with check (org_id = (select app.current_org_id()) and (select app.current_archetype()) in ('owner', 'admin'));
create policy ai_schedule_update on public.ai_schedule
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.ai_schedule to app_user;
grant update (agent_id, cadence, hour_local, weekday, recipients, enabled, dedup_window_hours, last_run_at, last_content_hash, updated_at)
  on public.ai_schedule to app_user;
create trigger ai_schedule_touch before update on public.ai_schedule
  for each row execute function app.set_updated_at();

create table public.ai_schedule_pref (
  org_id uuid not null references public.org (id) on delete restrict,
  schedule_id uuid not null,
  user_id uuid not null references public.user_profile (id),
  muted boolean not null default false,
  snoozed_until timestamptz,
  frequency text not null default 'every' check (frequency in ('every', 'daily', 'weekly')),
  updated_at timestamptz not null default now(),
  primary key (org_id, schedule_id, user_id),
  constraint ai_schedule_pref_schedule_fk foreign key (schedule_id, org_id) references public.ai_schedule (id, org_id) on delete restrict
);
alter table public.ai_schedule_pref enable row level security;
create policy ai_schedule_pref_all on public.ai_schedule_pref
  for all to app_user using (org_id = (select app.current_org_id()) and user_id = (select app.current_user_id()))
  with check (org_id = (select app.current_org_id()) and user_id = (select app.current_user_id()));
grant select, insert on public.ai_schedule_pref to app_user;
grant update (muted, snoozed_until, frequency, updated_at) on public.ai_schedule_pref to app_user;

-- ── approvals: the ai_action subject rides the existing engine ──────────────
alter table public.approval drop constraint if exists approval_subject_type_check;
alter table public.approval add constraint approval_subject_type_check
  check (subject_type in ('material_request', 'expense', 'quote_send', 'purchase_order', 'payment',
                          'task_completion', 'asset_disposal', 'leave_request', 'overtime_request',
                          'expense_claim', 'pay_run', 'journal_entry', 'scenario_apply', 'document_step',
                          'crm_discount', 'ai_action'));
alter table public.approval_rule drop constraint if exists approval_rule_subject_type_check;
alter table public.approval_rule add constraint approval_rule_subject_type_check
  check (subject_type in ('material_request', 'expense', 'quote_send', 'purchase_order', 'payment',
                          'task_completion', 'asset_disposal', 'leave_request', 'overtime_request',
                          'expense_claim', 'pay_run', 'journal_entry', 'scenario_apply', 'document_step',
                          'crm_discount', 'ai_action'));

-- ── platform discovery for the workers (dedicated-client only) ──────────────
create or replace function app.ai_queued_runs(p_limit integer)
returns table (id uuid, org_id uuid, requested_by uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  return query
    select r.id, r.org_id, r.requested_by
    from public.ai_run r
    where r.status = 'queued' and r.kind in ('background', 'schedule')
    order by r.created_at asc
    limit least(greatest(coalesce(p_limit, 20), 1), 200);
end
$$;
revoke all on function app.ai_queued_runs(integer) from public;
grant execute on function app.ai_queued_runs(integer) to app_user;

create or replace function app.orgs_with_ai_schedules()
returns table (org_id uuid, actor_user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  return query
    with live as (
      select s.org_id from public.ai_schedule s where s.enabled = true group by s.org_id
    )
    select live.org_id,
           (
             select m.user_id
             from public.membership m
             join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
             where m.org_id = live.org_id and r.archetype = 'owner' and m.deactivated_at is null
             order by m.created_at asc
             limit 1
           ) as actor_user_id
    from live
    where exists (
      select 1 from public.membership m2
      join public.role_definition r2 on r2.org_id = m2.org_id and r2.key = m2.role_key
      where m2.org_id = live.org_id and r2.archetype = 'owner' and m2.deactivated_at is null
    );
end
$$;
revoke all on function app.orgs_with_ai_schedules() from public;
grant execute on function app.orgs_with_ai_schedules() to app_user;
