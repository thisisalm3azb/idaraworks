-- H29B — one electronic-invoicing framework, per-country adapters, and the
-- establishment's privacy register (docs/H29-TRUTH-MAP.md ADR-72, ADR-73).
--
-- The framework is shared: channel, environment, credential reference,
-- lifecycle, idempotency, retry, evidence archive, health and kill switch.
-- ZATCA and the UAE Peppol network are adapters, not special cases.
--
-- Nothing here can send anything. A channel with no credential is UNAVAILABLE,
-- which is a different state from failing, and the adapter says which owner
-- action would change that.
--
-- Additive only; every surface stays behind FEATURE_COUNTRY_PACKS.

-- ── channels: one per establishment per adapter per environment ─────────────
create table public.einvoice_channel (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  establishment_id uuid not null,
  country char(2) not null,
  adapter_key text not null check (length(adapter_key) between 1 and 40),
  environment text not null check (environment in ('sandbox', 'production')),
  -- The lifecycle a channel moves through. `not_configured` is the state a
  -- channel is born in and the only one it can hold without a credential.
  status text not null default 'not_configured'
    check (status in ('not_configured', 'sandbox_configured', 'onboarding',
                      'validating', 'ready', 'suspended', 'retired')),
  -- A NAME of an environment variable or secret, never a secret.
  credential_ref text check (credential_ref is null or length(credential_ref) between 1 and 120),
  -- Set by an authorised person; a channel never activates itself.
  activated_at timestamptz,
  activated_by uuid references public.user_profile (id),
  -- The operator's stop, and the organisation's own.
  stopped boolean not null default false,
  stop_reason text check (stop_reason is null or length(stop_reason) <= 500),
  last_health_at timestamptz,
  last_health text check (last_health is null or length(last_health) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint einvoice_channel_id_org_uq unique (id, org_id),
  constraint einvoice_channel_fk foreign key (establishment_id, org_id)
    references public.establishment (id, org_id) on delete restrict,
  constraint einvoice_channel_uq unique (org_id, establishment_id, adapter_key, environment)
);
create index einvoice_channel_org_idx on public.einvoice_channel (org_id, establishment_id, status);
alter table public.einvoice_channel enable row level security;
create policy einvoice_channel_tenant on public.einvoice_channel for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.einvoice_channel to app_user;
grant update (status, credential_ref, activated_at, activated_by, stopped, stop_reason,
              last_health_at, last_health, updated_at)
  on public.einvoice_channel to app_user;
create trigger einvoice_channel_touch before update on public.einvoice_channel
  for each row execute function app.set_updated_at();

-- ── documents: one row per business document put through a channel ─────────
create table public.einvoice_document (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  channel_id uuid not null,
  establishment_id uuid not null,
  -- What it came from, e.g. ('invoice', <uuid>). Kept loose so any document
  -- kind can travel without this table knowing the module that owns it.
  source_kind text not null check (length(source_kind) between 1 and 40),
  source_id uuid not null,
  -- The authority's own identifiers.
  document_uuid uuid,
  -- The invoice counter value: increments per channel, never resets.
  counter bigint check (counter is null or counter > 0),
  -- The hash of this document and of the one before it in the chain.
  document_hash text check (document_hash is null or length(document_hash) <= 128),
  previous_hash text check (previous_hash is null or length(previous_hash) <= 128),
  qr_payload text check (qr_payload is null or length(qr_payload) <= 4000),
  status text not null default 'prepared'
    check (status in ('prepared', 'validated', 'submitted', 'reported', 'cleared',
                      'rejected', 'warning', 'retry_pending', 'cancelled', 'superseded',
                      'blocked_no_credential')),
  -- The same document submitted twice must not be sent twice.
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  attempts integer not null default 0 check (attempts >= 0),
  -- Immutable evidence of what was sent and what came back.
  request_evidence jsonb,
  response_evidence jsonb,
  error_code text check (error_code is null or length(error_code) <= 80),
  error_message text check (error_message is null or length(error_message) <= 2000),
  prepared_at timestamptz not null default now(),
  submitted_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint einvoice_document_id_org_uq unique (id, org_id),
  constraint einvoice_document_channel_fk foreign key (channel_id, org_id)
    references public.einvoice_channel (id, org_id) on delete restrict,
  constraint einvoice_document_establishment_fk foreign key (establishment_id, org_id)
    references public.establishment (id, org_id) on delete restrict,
  -- Idempotency is per channel: one key, one document.
  constraint einvoice_document_idempotency_uq unique (org_id, channel_id, idempotency_key),
  -- The counter is a chain: one value per channel.
  constraint einvoice_document_counter_uq unique (org_id, channel_id, counter)
);
create index einvoice_document_source_idx
  on public.einvoice_document (org_id, source_kind, source_id);
create index einvoice_document_status_idx
  on public.einvoice_document (org_id, channel_id, status, prepared_at desc);
alter table public.einvoice_document enable row level security;
create policy einvoice_document_tenant on public.einvoice_document for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.einvoice_document to app_user;
grant update (status, document_uuid, counter, document_hash, previous_hash, qr_payload,
              attempts, request_evidence, response_evidence, error_code, error_message,
              submitted_at, settled_at, updated_at)
  on public.einvoice_document to app_user;
create trigger einvoice_document_touch before update on public.einvoice_document
  for each row execute function app.set_updated_at();

-- ── attempts: append-only evidence, never edited ───────────────────────────
create table public.einvoice_event (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  document_id uuid not null,
  attempt integer not null check (attempt >= 1),
  outcome text not null check (length(outcome) between 1 and 40),
  -- What the authority said, verbatim, kept for evidence.
  detail jsonb,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  created_at timestamptz not null default now(),
  constraint einvoice_event_id_org_uq unique (id, org_id),
  constraint einvoice_event_document_fk foreign key (document_id, org_id)
    references public.einvoice_document (id, org_id) on delete restrict,
  constraint einvoice_event_attempt_uq unique (org_id, document_id, attempt)
);
create index einvoice_event_document_idx on public.einvoice_event (org_id, document_id, attempt);
alter table public.einvoice_event enable row level security;
create policy einvoice_event_tenant on public.einvoice_event for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
-- Evidence is written once and read forever: no UPDATE grant at all.
grant select, insert on public.einvoice_event to app_user;

-- ── the establishment's privacy register ───────────────────────────────────
-- Descriptive, never a compliance claim. It records what the organisation says
-- about its own processing so the readiness centre can show what is missing.
create table public.establishment_privacy (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  establishment_id uuid not null,
  data_category text not null check (length(data_category) between 1 and 80),
  purpose text not null check (length(purpose) between 1 and 500),
  provider text check (provider is null or length(provider) <= 200),
  processing_region text check (processing_region is null or length(processing_region) <= 80),
  retention text check (retention is null or length(retention) <= 200),
  cross_border boolean not null default false,
  transfer_basis text check (transfer_basis is null or length(transfer_basis) <= 200),
  lawful_basis text check (lawful_basis is null or length(lawful_basis) <= 200),
  -- Whether a person has reviewed this entry, which is not the same as it existing.
  reviewed_by uuid references public.user_profile (id),
  reviewed_at timestamptz,
  note text check (note is null or length(note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint establishment_privacy_id_org_uq unique (id, org_id),
  constraint establishment_privacy_fk foreign key (establishment_id, org_id)
    references public.establishment (id, org_id) on delete restrict,
  constraint establishment_privacy_uq unique (org_id, establishment_id, data_category)
);
create index establishment_privacy_idx on public.establishment_privacy (org_id, establishment_id);
alter table public.establishment_privacy enable row level security;
create policy establishment_privacy_tenant on public.establishment_privacy for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.establishment_privacy to app_user;
grant update (purpose, provider, processing_region, retention, cross_border, transfer_basis,
              lawful_basis, reviewed_by, reviewed_at, note, updated_at)
  on public.establishment_privacy to app_user;
create trigger establishment_privacy_touch before update on public.establishment_privacy
  for each row execute function app.set_updated_at();

-- ── the next counter in a channel's chain ──────────────────────────────────
-- A single statement so two concurrent preparations cannot take the same value.
create or replace function app.einvoice_next_counter(p_channel uuid)
returns bigint
language sql
volatile
security invoker
set search_path = ''
as $$
  select coalesce(max(counter), 0) + 1
  from public.einvoice_document
  where channel_id = p_channel;
$$;
grant execute on function app.einvoice_next_counter(uuid) to app_user;
