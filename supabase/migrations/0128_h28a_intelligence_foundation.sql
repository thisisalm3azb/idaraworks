-- H28A — Idara Intelligence foundation (docs/H28-TRUTH-MAP.md ADR-49..55, 61).
-- Platform operator identity, the extended AI usage ledger, provider and model
-- state with a circuit breaker, the effective-dated price book, the credit
-- policy, kill switches, platform audit, organisation AI policy rows, the
-- credit ledger, the privacy register, BYOK keys and the cap.idara presence
-- entitlement. Additive only: nothing here changes existing behaviour, and
-- every surface stays behind FEATURE_IDARA_INTELLIGENCE.

-- ── platform operator ────────────────────────────────────────────────────────
-- IdaraWorks staff who may open the owner economics centre. Written ONLY by
-- the guarded script (owner connection); app_user can read its own row.
create table public.platform_operator (
  user_id uuid primary key references public.user_profile (id) on delete restrict,
  granted_by uuid references public.user_profile (id),
  note text check (note is null or length(note) <= 500),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table public.platform_operator enable row level security;
create policy platform_operator_self on public.platform_operator
  for select to app_user using (user_id = (select app.current_user_id()));
grant select on public.platform_operator to app_user;

create or replace function app.is_platform_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_operator p
    where p.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      and p.revoked_at is null
  );
$$;
revoke all on function app.is_platform_operator() from public;
grant execute on function app.is_platform_operator() to app_user;

-- Operator reads run in a USER context with no organisation (withUserCtx):
-- an org-scoped session can never call these, and a non-operator is refused.
create or replace function app.assert_platform_operator()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if nullif(current_setting('app.org_id', true), '') is not null then
    raise exception 'platform operator only: must run without an organisation context';
  end if;
  if not app.is_platform_operator() then
    raise exception 'platform operator only';
  end if;
end
$$;
revoke all on function app.assert_platform_operator() from public;
grant execute on function app.assert_platform_operator() to app_user;

-- ── platform audit (global, operator-only reads, definer-only writes) ───────
create table public.platform_audit (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null,
  action text not null check (length(action) between 1 and 80),
  scope text check (scope is null or length(scope) <= 40),
  scope_key text check (scope_key is null or length(scope_key) <= 120),
  summary text not null check (length(summary) <= 2000),
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
create index platform_audit_created_idx on public.platform_audit (created_at desc);
alter table public.platform_audit enable row level security;
create policy platform_audit_operator_read on public.platform_audit
  for select to app_user using (app.is_platform_operator());
grant select on public.platform_audit to app_user;

-- ── ai_interaction: the ONE usage ledger, extended additively ───────────────
alter table public.ai_interaction
  add column agent_id text check (agent_id is null or length(agent_id) <= 40),
  add column conversation_id uuid,
  add column run_id uuid,
  add column step_no integer check (step_no is null or step_no >= 0),
  add column model_version text check (model_version is null or length(model_version) <= 120),
  add column cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  add column cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  add column reasoning_tokens integer not null default 0 check (reasoning_tokens >= 0),
  add column tool_calls integer not null default 0 check (tool_calls >= 0),
  add column extras jsonb not null default '{}'::jsonb,
  add column provider_request_id text check (provider_request_id is null or length(provider_request_id) <= 200),
  add column latency_ms integer check (latency_ms is null or latency_ms >= 0),
  add column retry_count integer not null default 0 check (retry_count >= 0),
  add column est_cost_micros bigint check (est_cost_micros is null or est_cost_micros >= 0),
  add column est_currency char(3),
  add column price_book_id uuid,
  add column actual_cost_micros bigint check (actual_cost_micros is null or actual_cost_micros >= 0),
  add column actual_currency char(3),
  add column rate_source text check (rate_source is null or length(rate_source) <= 40),
  add column budget_decision text not null default 'allow'
    check (budget_decision in ('allow', 'warn', 'deny', 'stopped', 'breaker')),
  add column purpose text check (purpose is null or length(purpose) <= 60),
  add column error text check (error is null or length(error) <= 1000);
alter table public.ai_interaction drop constraint ai_interaction_feature_check;
alter table public.ai_interaction add constraint ai_interaction_feature_check
  check (feature in ('digest_narration', 'customer_draft', 'config_proposal',
                     'agent_run', 'agent_route', 'agent_tool', 'agent_eval', 'schedule_run', 'gateway'));
create index ai_interaction_org_run_idx on public.ai_interaction (org_id, run_id);
create index ai_interaction_org_agent_idx on public.ai_interaction (org_id, agent_id, created_at);
create index ai_interaction_created_idx on public.ai_interaction (created_at);

-- ── provider and model state (global; reads by every session, writes by definer) ─
create table public.ai_provider_state (
  provider_key text primary key check (provider_key ~ '^[a-z0-9_]{1,40}$'),
  enabled boolean not null default true,
  health text not null default 'unknown' check (health in ('unknown', 'healthy', 'degraded', 'down')),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  breaker_open_until timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 500),
  updated_at timestamptz not null default now()
);
alter table public.ai_provider_state enable row level security;
create policy ai_provider_state_read on public.ai_provider_state for select to app_user using (true);
grant select on public.ai_provider_state to app_user;

create table public.ai_model_state (
  model_key text primary key check (model_key ~ '^[a-z0-9_:.-]{1,80}$'),
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.ai_model_state enable row level security;
create policy ai_model_state_read on public.ai_model_state for select to app_user using (true);
grant select on public.ai_model_state to app_user;

-- The gateway reports every call outcome; five consecutive failures open the
-- breaker for five minutes. Called from tenant sessions, so deliberately NOT
-- operator-guarded (it can only move health fields).
create or replace function app.ai_provider_report(p_provider text, p_ok boolean, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.ai_provider_state (provider_key) values (p_provider)
  on conflict (provider_key) do nothing;
  if p_ok then
    update public.ai_provider_state
       set consecutive_failures = 0, health = 'healthy', breaker_open_until = null,
           last_success_at = now(), updated_at = now()
     where provider_key = p_provider;
  else
    update public.ai_provider_state
       set consecutive_failures = consecutive_failures + 1,
           last_failure_at = now(),
           last_error = left(coalesce(p_error, 'error'), 500),
           health = case when consecutive_failures + 1 >= 5 then 'down' else 'degraded' end,
           breaker_open_until = case when consecutive_failures + 1 >= 5 then now() + interval '5 minutes'
                                     else breaker_open_until end,
           updated_at = now()
     where provider_key = p_provider;
  end if;
end
$$;
revoke all on function app.ai_provider_report(text, boolean, text) from public;
grant execute on function app.ai_provider_report(text, boolean, text) to app_user;

-- ── price book (global, effective-dated, source-cited; operator writes) ─────
create table public.ai_price_book (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null check (provider_key ~ '^[a-z0-9_]{1,40}$'),
  model_key text not null check (model_key ~ '^[a-z0-9_:.-]{1,80}$'),
  effective_from timestamptz not null,
  effective_to timestamptz check (effective_to is null or effective_to > effective_from),
  currency char(3) not null default 'USD',
  input_per_mtok_micros bigint not null check (input_per_mtok_micros >= 0),
  output_per_mtok_micros bigint not null check (output_per_mtok_micros >= 0),
  cache_read_per_mtok_micros bigint check (cache_read_per_mtok_micros is null or cache_read_per_mtok_micros >= 0),
  cache_write_per_mtok_micros bigint check (cache_write_per_mtok_micros is null or cache_write_per_mtok_micros >= 0),
  reasoning_per_mtok_micros bigint check (reasoning_per_mtok_micros is null or reasoning_per_mtok_micros >= 0),
  tool_extras jsonb not null default '{}'::jsonb,
  source_url text check (source_url is null or length(source_url) <= 500),
  version integer not null default 1 check (version >= 1),
  recorded_by uuid,
  note text check (note is null or length(note) <= 500),
  created_at timestamptz not null default now(),
  constraint ai_price_book_model_from_uq unique (model_key, effective_from)
);
create index ai_price_book_model_idx on public.ai_price_book (model_key, effective_from desc);
alter table public.ai_price_book enable row level security;
create policy ai_price_book_read on public.ai_price_book for select to app_user using (true);
grant select on public.ai_price_book to app_user;

-- Published list prices fetched 2026-09-03 (docs/H28-TRUTH-MAP.md C.2). Only
-- rows with a fetched source are seeded; unpriced models cannot be routed.
insert into public.ai_price_book
  (provider_key, model_key, effective_from, currency, input_per_mtok_micros, output_per_mtok_micros,
   cache_read_per_mtok_micros, cache_write_per_mtok_micros, source_url, note)
values
  ('openai', 'openai:gpt-5-nano', '2026-09-03T00:00:00Z', 'USD', 50000, 400000, 5000, null,
   'https://developers.openai.com/api/docs/pricing', 'gpt-5-nano list price: $0.05 input, $0.005 cached input, $0.40 output per 1M tokens (fetched 2026-09-03)'),
  ('anthropic', 'anthropic:claude-haiku-4-5', '2026-09-03T00:00:00Z', 'USD', 1000000, 5000000, 100000, 1250000,
   'https://platform.claude.com/docs/en/about-claude/pricing', 'Claude Haiku 4.5 list price: $1 input, $1.25 5-minute cache write, $0.10 cache read, $5 output per MTok (fetched 2026-09-03)');

-- ── credit policy (global, effective-dated): one credit = one US cent of estimated cost ─
create table public.ai_credit_policy (
  id uuid primary key default gen_random_uuid(),
  effective_from timestamptz not null unique,
  credits_per_usd_cent numeric(12, 4) not null check (credits_per_usd_cent > 0),
  note text check (note is null or length(note) <= 500),
  recorded_by uuid,
  created_at timestamptz not null default now()
);
alter table public.ai_credit_policy enable row level security;
create policy ai_credit_policy_read on public.ai_credit_policy for select to app_user using (true);
grant select on public.ai_credit_policy to app_user;
insert into public.ai_credit_policy (effective_from, credits_per_usd_cent, note)
values ('2026-09-03T00:00:00Z', 1, 'H28 initial policy: 1 credit = 1 US cent of estimated provider cost');

-- ── kill switches (global; operator writes) ─────────────────────────────────
create table public.ai_kill_switch (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('global', 'org', 'agent', 'provider', 'model')),
  scope_key text not null default '' check (length(scope_key) <= 120),
  active boolean not null default true,
  reason text check (reason is null or length(reason) <= 500),
  set_by uuid not null,
  set_at timestamptz not null default now(),
  cleared_by uuid,
  cleared_at timestamptz
);
create unique index ai_kill_switch_active_uq on public.ai_kill_switch (scope, scope_key) where active;
alter table public.ai_kill_switch enable row level security;
create policy ai_kill_switch_read on public.ai_kill_switch for select to app_user using (true);
grant select on public.ai_kill_switch to app_user;

-- ── organisation AI policy (append-only history; latest version effective) ───
create table public.ai_entitlement (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  version integer not null check (version >= 1),
  effective_from timestamptz not null default now(),
  effective_to timestamptz check (effective_to is null or effective_to > effective_from),
  mode text not null default 'disabled'
    check (mode in ('disabled', 'trial', 'included', 'prepaid', 'enterprise', 'byok')),
  -- null = the plan's limit.ai_credits_month (with add-ons and overrides).
  monthly_credits integer check (monthly_credits is null or monthly_credits >= 0),
  daily_credit_limit integer check (daily_credit_limit is null or daily_credit_limit >= 0),
  per_user_daily_credits integer check (per_user_daily_credits is null or per_user_daily_credits >= 0),
  per_agent_limits jsonb not null default '{}'::jsonb,
  model_allow jsonb not null default '[]'::jsonb,
  max_cost_per_request_credits integer check (max_cost_per_request_credits is null or max_cost_per_request_credits >= 0),
  soft_warn_pct integer not null default 80 check (soft_warn_pct between 1 and 100),
  hard_stop boolean not null default true,
  overage_allowed boolean not null default false,
  restricted_domains jsonb not null default '[]'::jsonb,
  ai_enabled_by_org boolean not null default true,
  reason text check (reason is null or length(reason) <= 500),
  set_by uuid,
  set_by_operator boolean not null default false,
  created_at timestamptz not null default now(),
  constraint ai_entitlement_id_org_uq unique (id, org_id),
  constraint ai_entitlement_org_version_uq unique (org_id, version)
);
create index ai_entitlement_org_idx on public.ai_entitlement (org_id, version desc);
alter table public.ai_entitlement enable row level security;
create policy ai_entitlement_select on public.ai_entitlement
  for select to app_user using (org_id = (select app.current_org_id()));
create policy ai_entitlement_insert on public.ai_entitlement
  for insert to app_user with check (org_id = (select app.current_org_id()));
-- History is immutable: a new version supersedes; no update or delete grant.
grant select, insert on public.ai_entitlement to app_user;

-- ── credit ledger (append-only; consumption by the gateway, grants by operators) ─
create table public.ai_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  kind text not null check (kind in ('pack', 'manual', 'allowance_adjust', 'consumption', 'expiry', 'refund')),
  credits integer not null,
  period_key text not null check (period_key ~ '^[0-9]{4}-[0-9]{2}$'),
  ref_type text check (ref_type is null or length(ref_type) <= 40),
  ref_id uuid,
  note text check (note is null or length(note) <= 500),
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint ai_credit_ledger_id_org_uq unique (id, org_id)
);
create index ai_credit_ledger_org_period_idx on public.ai_credit_ledger (org_id, period_key, kind);
alter table public.ai_credit_ledger enable row level security;
create policy ai_credit_ledger_select on public.ai_credit_ledger
  for select to app_user using (org_id = (select app.current_org_id()));
create policy ai_credit_ledger_insert on public.ai_credit_ledger
  for insert to app_user with check (org_id = (select app.current_org_id()));
grant select, insert on public.ai_credit_ledger to app_user;

-- ── privacy register: what the organisation recorded before a provider may be used ─
create table public.ai_privacy_register (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  provider_key text not null check (provider_key ~ '^[a-z0-9_]{1,40}$'),
  lawful_basis text not null check (length(lawful_basis) between 1 and 200),
  processor_agreement_ref text not null check (length(processor_agreement_ref) between 1 and 200),
  transfer_mechanism text not null check (length(transfer_mechanism) between 1 and 200),
  retention_note text check (retention_note is null or length(retention_note) <= 500),
  minimisation_confirmed boolean not null default false,
  ropa_ref text check (ropa_ref is null or length(ropa_ref) <= 200),
  dpo_checked boolean not null default false,
  recorded_by uuid not null references public.user_profile (id),
  recorded_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.user_profile (id),
  constraint ai_privacy_register_id_org_uq unique (id, org_id)
);
create index ai_privacy_register_org_idx on public.ai_privacy_register (org_id, provider_key);
alter table public.ai_privacy_register enable row level security;
create policy ai_privacy_register_select on public.ai_privacy_register
  for select to app_user using (org_id = (select app.current_org_id()));
create policy ai_privacy_register_insert on public.ai_privacy_register
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy ai_privacy_register_update on public.ai_privacy_register
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.ai_privacy_register to app_user;
grant update (revoked_at, revoked_by) on public.ai_privacy_register to app_user;

-- ── BYOK keys: ciphertext columns are NOT readable by app_user ──────────────
create table public.ai_byok_key (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  provider_key text not null check (provider_key ~ '^[a-z0-9_]{1,40}$'),
  key_ciphertext text not null,
  key_iv text not null,
  key_tag text not null,
  last4 text not null check (length(last4) between 1 and 4),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.user_profile (id),
  constraint ai_byok_key_id_org_uq unique (id, org_id)
);
create index ai_byok_key_org_idx on public.ai_byok_key (org_id, provider_key);
alter table public.ai_byok_key enable row level security;
create policy ai_byok_key_select on public.ai_byok_key
  for select to app_user using (org_id = (select app.current_org_id()));
create policy ai_byok_key_insert on public.ai_byok_key
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy ai_byok_key_update on public.ai_byok_key
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select (id, org_id, provider_key, last4, created_by, created_at, revoked_at, revoked_by)
  on public.ai_byok_key to app_user;
grant insert on public.ai_byok_key to app_user;
grant update (revoked_at, revoked_by) on public.ai_byok_key to app_user;

-- The gateway alone reads the ciphertext, and only for the current organisation.
create or replace function app.ai_byok_ciphertext(p_id uuid)
returns table (key_ciphertext text, key_iv text, key_tag text)
language sql
stable
security definer
set search_path = ''
as $$
  select k.key_ciphertext, k.key_iv, k.key_tag
  from public.ai_byok_key k
  where k.id = p_id
    and k.org_id = nullif(current_setting('app.org_id', true), '')::uuid
    and k.revoked_at is null;
$$;
revoke all on function app.ai_byok_ciphertext(uuid) from public;
grant execute on function app.ai_byok_ciphertext(uuid) to app_user;

-- ── operator writes (audited) ───────────────────────────────────────────────
create or replace function app.ai_kill_switch_set(p_scope text, p_key text, p_active boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
  perform app.assert_platform_operator();
  if p_active then
    insert into public.ai_kill_switch (scope, scope_key, active, reason, set_by)
    values (p_scope, coalesce(p_key, ''), true, p_reason, v_actor)
    on conflict (scope, scope_key) where active do nothing;
  else
    update public.ai_kill_switch
       set active = false, cleared_by = v_actor, cleared_at = now()
     where scope = p_scope and scope_key = coalesce(p_key, '') and active;
  end if;
  insert into public.platform_audit (actor_user_id, action, scope, scope_key, summary)
  values (v_actor, case when p_active then 'ai.stop' else 'ai.resume' end, p_scope, coalesce(p_key, ''),
          left(coalesce(p_reason, ''), 2000));
end
$$;
revoke all on function app.ai_kill_switch_set(text, text, boolean, text) from public;
grant execute on function app.ai_kill_switch_set(text, text, boolean, text) to app_user;

create or replace function app.ai_provider_set_enabled(p_provider text, p_enabled boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
  perform app.assert_platform_operator();
  insert into public.ai_provider_state (provider_key, enabled) values (p_provider, p_enabled)
  on conflict (provider_key) do update set enabled = excluded.enabled, updated_at = now();
  insert into public.platform_audit (actor_user_id, action, scope, scope_key, summary)
  values (v_actor, 'ai.provider.enabled', 'provider', p_provider,
          left(coalesce(p_reason, '') || ' enabled=' || p_enabled::text, 2000));
end
$$;
revoke all on function app.ai_provider_set_enabled(text, boolean, text) from public;
grant execute on function app.ai_provider_set_enabled(text, boolean, text) to app_user;

create or replace function app.ai_model_set_enabled(p_model text, p_enabled boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
  perform app.assert_platform_operator();
  insert into public.ai_model_state (model_key, enabled) values (p_model, p_enabled)
  on conflict (model_key) do update set enabled = excluded.enabled, updated_at = now();
  insert into public.platform_audit (actor_user_id, action, scope, scope_key, summary)
  values (v_actor, 'ai.model.enabled', 'model', p_model,
          left(coalesce(p_reason, '') || ' enabled=' || p_enabled::text, 2000));
end
$$;
revoke all on function app.ai_model_set_enabled(text, boolean, text) from public;
grant execute on function app.ai_model_set_enabled(text, boolean, text) to app_user;

create or replace function app.ai_price_book_add(
  p_provider text, p_model text, p_effective_from timestamptz, p_currency char(3),
  p_input bigint, p_output bigint, p_cache_read bigint, p_cache_write bigint, p_reasoning bigint,
  p_source_url text, p_note text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_id uuid;
  v_version integer;
begin
  perform app.assert_platform_operator();
  select coalesce(max(version), 0) + 1 into v_version from public.ai_price_book where model_key = p_model;
  update public.ai_price_book set effective_to = p_effective_from
   where model_key = p_model and effective_to is null and effective_from < p_effective_from;
  insert into public.ai_price_book
    (provider_key, model_key, effective_from, currency, input_per_mtok_micros, output_per_mtok_micros,
     cache_read_per_mtok_micros, cache_write_per_mtok_micros, reasoning_per_mtok_micros,
     source_url, version, recorded_by, note)
  values (p_provider, p_model, p_effective_from, p_currency, p_input, p_output, p_cache_read, p_cache_write,
          p_reasoning, p_source_url, v_version, v_actor, p_note)
  returning id into v_id;
  insert into public.platform_audit (actor_user_id, action, scope, scope_key, summary, after_data)
  values (v_actor, 'ai.price_book.add', 'model', p_model,
          left('price book v' || v_version::text || ' from ' || p_effective_from::text, 2000),
          jsonb_build_object('input', p_input, 'output', p_output, 'cache_read', p_cache_read,
                             'cache_write', p_cache_write, 'reasoning', p_reasoning, 'source', p_source_url));
  return v_id;
end
$$;
revoke all on function app.ai_price_book_add(text, text, timestamptz, char, bigint, bigint, bigint, bigint, bigint, text, text) from public;
grant execute on function app.ai_price_book_add(text, text, timestamptz, char, bigint, bigint, bigint, bigint, bigint, text, text) to app_user;

create or replace function app.ai_entitlement_set(p_org uuid, p_policy jsonb, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_id uuid;
  v_version integer;
begin
  perform app.assert_platform_operator();
  select coalesce(max(version), 0) + 1 into v_version from public.ai_entitlement where org_id = p_org;
  insert into public.ai_entitlement
    (org_id, version, mode, monthly_credits, daily_credit_limit, per_user_daily_credits, per_agent_limits,
     model_allow, max_cost_per_request_credits, soft_warn_pct, hard_stop, overage_allowed,
     restricted_domains, ai_enabled_by_org, reason, set_by, set_by_operator)
  values (
    p_org, v_version,
    coalesce(p_policy->>'mode', 'disabled'),
    (p_policy->>'monthly_credits')::integer,
    (p_policy->>'daily_credit_limit')::integer,
    (p_policy->>'per_user_daily_credits')::integer,
    coalesce(p_policy->'per_agent_limits', '{}'::jsonb),
    coalesce(p_policy->'model_allow', '[]'::jsonb),
    (p_policy->>'max_cost_per_request_credits')::integer,
    coalesce((p_policy->>'soft_warn_pct')::integer, 80),
    coalesce((p_policy->>'hard_stop')::boolean, true),
    coalesce((p_policy->>'overage_allowed')::boolean, false),
    coalesce(p_policy->'restricted_domains', '[]'::jsonb),
    coalesce((p_policy->>'ai_enabled_by_org')::boolean, true),
    p_reason, v_actor, true)
  returning id into v_id;
  insert into public.platform_audit (actor_user_id, action, scope, scope_key, summary, after_data)
  values (v_actor, 'ai.entitlement.set', 'org', p_org::text,
          left('policy v' || v_version::text || ': ' || coalesce(p_reason, ''), 2000), p_policy);
  return v_id;
end
$$;
revoke all on function app.ai_entitlement_set(uuid, jsonb, text) from public;
grant execute on function app.ai_entitlement_set(uuid, jsonb, text) to app_user;

create or replace function app.ai_credit_grant(p_org uuid, p_credits integer, p_kind text, p_period text, p_note text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_id uuid;
begin
  perform app.assert_platform_operator();
  if p_kind not in ('pack', 'manual', 'allowance_adjust', 'refund', 'expiry') then
    raise exception 'operator credit kind must be pack, manual, allowance_adjust, refund or expiry';
  end if;
  insert into public.ai_credit_ledger (org_id, kind, credits, period_key, note, created_by)
  values (p_org, p_kind, p_credits, p_period, p_note, v_actor)
  returning id into v_id;
  insert into public.platform_audit (actor_user_id, action, scope, scope_key, summary)
  values (v_actor, 'ai.credit.grant', 'org', p_org::text,
          left(p_kind || ' ' || p_credits::text || ' credits for ' || p_period || ': ' || coalesce(p_note, ''), 2000));
  return v_id;
end
$$;
revoke all on function app.ai_credit_grant(uuid, integer, text, text, text) from public;
grant execute on function app.ai_credit_grant(uuid, integer, text, text, text) to app_user;

-- ── operator reads (cross-organisation aggregates, every number drills to rows) ─
create or replace function app.ai_platform_usage(p_from timestamptz, p_to timestamptz)
returns table (
  org_id uuid, org_name text, agent_id text, provider text, model text,
  requests bigint, failed bigint, retried bigint, denied bigint,
  input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, reasoning_tokens bigint,
  est_cost_micros bigint, actual_cost_micros bigint, credits bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_operator();
  return query
    select i.org_id, o.name, i.agent_id, i.provider, i.model,
           count(*)::bigint,
           count(*) filter (where i.status = 'failed')::bigint,
           count(*) filter (where i.retry_count > 0)::bigint,
           count(*) filter (where i.budget_decision in ('deny', 'stopped', 'breaker'))::bigint,
           coalesce(sum(i.input_tokens), 0)::bigint, coalesce(sum(i.output_tokens), 0)::bigint,
           coalesce(sum(i.cache_read_tokens), 0)::bigint, coalesce(sum(i.reasoning_tokens), 0)::bigint,
           coalesce(sum(i.est_cost_micros), 0)::bigint, coalesce(sum(i.actual_cost_micros), 0)::bigint,
           coalesce(sum(i.credits), 0)::bigint
    from public.ai_interaction i
    join public.org o on o.id = i.org_id
    where i.created_at >= p_from and i.created_at < p_to
    group by i.org_id, o.name, i.agent_id, i.provider, i.model;
end
$$;
revoke all on function app.ai_platform_usage(timestamptz, timestamptz) from public;
grant execute on function app.ai_platform_usage(timestamptz, timestamptz) to app_user;

create or replace function app.ai_platform_usage_rows(p_org uuid, p_from timestamptz, p_to timestamptz, p_limit integer, p_offset integer)
returns table (
  id uuid, org_id uuid, created_at timestamptz, agent_id text, provider text, model text, model_version text,
  feature text, purpose text, status text, budget_decision text, retry_count integer,
  input_tokens integer, output_tokens integer, cache_read_tokens integer, cache_write_tokens integer,
  reasoning_tokens integer, tool_calls integer, latency_ms integer, provider_request_id text,
  est_cost_micros bigint, est_currency char(3), actual_cost_micros bigint, credits integer,
  run_id uuid, conversation_id uuid, created_by uuid, error text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_operator();
  return query
    select i.id, i.org_id, i.created_at, i.agent_id, i.provider, i.model, i.model_version,
           i.feature, i.purpose, i.status, i.budget_decision, i.retry_count,
           i.input_tokens, i.output_tokens, i.cache_read_tokens, i.cache_write_tokens,
           i.reasoning_tokens, i.tool_calls, i.latency_ms, i.provider_request_id,
           i.est_cost_micros, i.est_currency, i.actual_cost_micros, i.credits,
           i.run_id, i.conversation_id, i.created_by, i.error
    from public.ai_interaction i
    where (p_org is null or i.org_id = p_org)
      and i.created_at >= p_from and i.created_at < p_to
    order by i.created_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 1000) offset greatest(coalesce(p_offset, 0), 0);
end
$$;
revoke all on function app.ai_platform_usage_rows(uuid, timestamptz, timestamptz, integer, integer) from public;
grant execute on function app.ai_platform_usage_rows(uuid, timestamptz, timestamptz, integer, integer) to app_user;

create or replace function app.ai_platform_orgs()
returns table (org_id uuid, org_name text, mode text, ai_enabled_by_org boolean, policy_version integer,
               byok_providers text[], privacy_providers text[])
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_operator();
  return query
    select o.id, o.name, e.mode, e.ai_enabled_by_org, e.version,
           (select coalesce(array_agg(distinct k.provider_key), '{}') from public.ai_byok_key k
             where k.org_id = o.id and k.revoked_at is null),
           (select coalesce(array_agg(distinct r.provider_key), '{}') from public.ai_privacy_register r
             where r.org_id = o.id and r.revoked_at is null)
    from public.org o
    left join lateral (
      select x.mode, x.ai_enabled_by_org, x.version
      from public.ai_entitlement x
      where x.org_id = o.id and x.effective_from <= now()
        and (x.effective_to is null or x.effective_to > now())
      order by x.version desc limit 1
    ) e on true
    order by o.name;
end
$$;
revoke all on function app.ai_platform_orgs() from public;
grant execute on function app.ai_platform_orgs() to app_user;

-- ── entitlement presence key (nav/module presence only; the flag is the gate) ─
insert into public.entitlement_def (key, kind) values ('cap.idara', 'feature');
insert into public.plan_entitlement (plan_key, entitlement_key, enabled)
select p.key, 'cap.idara', true
from public.plan p
where p.key in ('free', 'starter', 'growth', 'business');
