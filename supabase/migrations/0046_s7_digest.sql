-- 0046_s7_digest (S7 — "Improve", part 2): the deterministic digest store + the AI
-- interaction/credit ledger (doc 04 "Digest assembly"; BUILD_BIBLE §10).
--
-- The digest is COMPOSED in the staggered nightly window per org, per audience role, and
-- PERSISTED (doc 11 "DB: digest") so the morning card read is cheap and evidence links
-- render from the stored structured payload. The payload is redacted AT COLLECTION per
-- audience (F-23) — a digest row for a role never contains a number that role may not see.
-- AI narration is a DISABLED SEAM in S7 (no provider configured); the deterministic payload
-- is the always-shippable digest and the AI-outage / credits-exhausted fallback (doc 04).
--
-- ai_interaction is the append-only ledger every metered LLM call records (BUILD_BIBLE
-- §10.7/10.10): org, feature, tokens, cost, and the numbers-subset validator verdict.
-- Deterministic analytics are NEVER metered (doc 04) — only narration + customer drafts.
-- Forward-only.

create table public.digest (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  -- One digest per org, per audience role, per working-morning date.
  audience text not null check (audience in ('owner', 'admin', 'manager', 'accounts', 'procurement', 'foreman')),
  digest_date date not null,
  -- The deterministic, per-audience-redacted structured digest (sections + ranked items +
  -- evidence refs). The card renders headline + expand from this; evidence links come from
  -- the structured source here, NEVER parsed from narration prose (doc 04).
  payload jsonb not null,
  -- The optional AI narration (4-8 sentences) — null until generated; disabled in S7.
  narration text check (narration is null or length(narration) <= 4000),
  narration_lang text check (narration_lang is null or narration_lang in ('en', 'ar')),
  narration_status text not null default 'none'
    check (narration_status in ('none', 'pending', 'generated', 'failed', 'disabled')),
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint digest_id_org_uq unique (id, org_id),
  constraint digest_org_audience_date_uq unique (org_id, audience, digest_date)
);
create index digest_org_date_idx on public.digest (org_id, digest_date desc);
alter table public.digest enable row level security;
create policy digest_select on public.digest
  for select to app_user using (org_id = (select app.current_org_id()));
create policy digest_insert on public.digest
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy digest_update on public.digest
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
-- The nightly per-org composer (defineOrgFunction, org ctx) writes it; the digest.view
-- archetype gate is the SERVICE assertCan. No DELETE grant (D-1.7). Only narration fields
-- are updated post-compose (lazy narration fill); the deterministic payload is immutable
-- once composed for a given day (a recompose replaces the whole row via the unique key).
grant select, insert on public.digest to app_user;
grant update (narration, narration_lang, narration_status, updated_at) on public.digest to app_user;

create table public.ai_interaction (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  -- Which metered Layer-B surface (doc 09: only narration/drafts/conversation are metered).
  feature text not null check (feature in ('digest_narration', 'customer_draft')),
  provider text check (provider is null or length(provider) <= 40),
  model text check (model is null or length(model) <= 80),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  -- Credits consumed (limit.ai_credits_month is metered against sum(credits) this month).
  credits integer not null default 0 check (credits >= 0),
  -- Cost in micro-units of the platform billing currency (audit trail; nullable pre-billing).
  cost_micros bigint check (cost_micros is null or cost_micros >= 0),
  -- The numbers-subset validator verdict for a narration/draft (pass = shipped; fail =
  -- fell back to deterministic). 'na' for calls that do not narrate numbers.
  validator_verdict text not null default 'na'
    check (validator_verdict in ('pass', 'fail', 'na')),
  status text not null default 'ok' check (status in ('ok', 'failed', 'disabled')),
  subject_type text check (subject_type is null or length(subject_type) <= 40),
  subject_id uuid,
  created_by uuid references public.user_profile (id),
  created_at timestamptz not null default now()
);
create index ai_interaction_org_month_idx on public.ai_interaction (org_id, created_at);
create index ai_interaction_org_feature_idx on public.ai_interaction (org_id, feature, created_at);
alter table public.ai_interaction enable row level security;
create policy ai_interaction_select on public.ai_interaction
  for select to app_user using (org_id = (select app.current_org_id()));
create policy ai_interaction_insert on public.ai_interaction
  for insert to app_user with check (org_id = (select app.current_org_id()));
-- Append-only ledger: select + insert only, NO update/delete grant (immutable audit of AI
-- spend, mirrors audit_log). The credit meter reads sum(credits) over the month.
grant select, insert on public.ai_interaction to app_user;
