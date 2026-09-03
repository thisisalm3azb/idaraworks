-- H29A — the country-pack lifecycle and the establishment.
--
-- Pack CONTENT is code (src/platform/country/packs), reviewed and tested like
-- code. Pack LIFECYCLE is data: which versions exist, what state each is in,
-- when it applies, who reviewed it and which establishment adopted it when
-- (docs/H29-TRUTH-MAP.md ADR-66..70). Nothing here lets an ordinary user edit a
-- legal rule.
--
-- The establishment is the jurisdictional unit (ADR-67). An organisation that
-- never creates one keeps exactly its current behaviour: reads fall back to the
-- organisation's own country, timezone, currency and working week.
--
-- Additive only; every surface stays behind FEATURE_COUNTRY_PACKS.

-- ── the pack registry mirror (global reference data) ────────────────────────
-- Readable by every tenant so a surface can name a pack without a round trip
-- through the platform. Writable only through the operator functions below.
create table public.country_pack (
  pack_key text primary key check (pack_key ~ '^[A-Z]{2}-[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  country char(2) not null,
  jurisdiction text not null check (length(jurisdiction) between 1 and 200),
  version text not null check (length(version) between 1 and 40),
  status text not null check (status in ('draft', 'review', 'approved', 'active', 'retired', 'superseded')),
  effective_from date not null,
  -- Exclusive: [effective_from, effective_to). Null is open-ended.
  effective_to date,
  supersedes text references public.country_pack (pack_key),
  owner text not null default 'platform',
  supported_languages jsonb not null default '[]'::jsonb,
  currency char(3) not null,
  default_timezone text not null,
  -- The source citations behind the pack, as recorded in the evidence log.
  sources jsonb not null default '[]'::jsonb,
  known_limitations jsonb not null default '[]'::jsonb,
  change_history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);
create index country_pack_country_idx on public.country_pack (country, effective_from);

-- No two resolvable versions of one country may cover the same day. Enforced in
-- the database, not only in the registry's own soundness check.
create extension if not exists btree_gist;
alter table public.country_pack
  add constraint country_pack_no_overlap
  exclude using gist (
    country with =,
    daterange(effective_from, effective_to, '[)') with &&
  ) where (status in ('approved', 'active', 'retired', 'superseded'));

alter table public.country_pack enable row level security;
create policy country_pack_read on public.country_pack for select to app_user using (true);
grant select on public.country_pack to app_user;
create trigger country_pack_touch before update on public.country_pack
  for each row execute function app.set_updated_at();

-- ── pack reviews (global; the honest states behind "ready") ─────────────────
create table public.country_pack_review (
  id uuid primary key default gen_random_uuid(),
  pack_key text not null references public.country_pack (pack_key) on delete restrict,
  kind text not null check (kind in ('internal', 'native_language', 'professional', 'provider')),
  state text not null check (state in ('not_started', 'in_progress', 'passed', 'failed')),
  reviewer text,
  note text check (note is null or length(note) <= 1000),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint country_pack_review_uq unique (pack_key, kind)
);
alter table public.country_pack_review enable row level security;
create policy country_pack_review_read on public.country_pack_review for select to app_user using (true);
grant select on public.country_pack_review to app_user;
create trigger country_pack_review_touch before update on public.country_pack_review
  for each row execute function app.set_updated_at();

-- ── establishments (tenant data) ───────────────────────────────────────────
create table public.establishment (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,23}$'),
  legal_name text not null check (length(legal_name) between 1 and 200),
  trading_name text check (trading_name is null or length(trading_name) between 1 and 200),
  -- Names as entered, in the script they were entered in (ADR-78).
  legal_name_local text check (legal_name_local is null or length(legal_name_local) between 1 and 200),
  country char(2) not null,
  -- The pack version this establishment currently resolves through. Null until
  -- an authorised person adopts one.
  pack_key text references public.country_pack (pack_key),
  timezone text not null,
  base_currency char(3) not null,
  -- ["sun","mon",...] — the establishment's own working days.
  working_days jsonb not null default '[]'::jsonb,
  -- The country's address shape, keyed by the pack's own field keys.
  address jsonb not null default '{}'::jsonb,
  -- Invoice identity: the name, address and registration shown on documents.
  invoice_identity jsonb not null default '{}'::jsonb,
  -- Bank details used for this establishment's own documents.
  banking jsonb not null default '{}'::jsonb,
  is_primary boolean not null default false,
  status text not null default 'active' check (status in ('active', 'inactive')),
  -- Set by a person who has checked the registrations against the documents.
  verification_state text not null default 'unverified'
    check (verification_state in ('unverified', 'self_declared', 'verified')),
  verified_by uuid references public.user_profile (id),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint establishment_id_org_uq unique (id, org_id),
  constraint establishment_code_uq unique (org_id, code)
);
create index establishment_org_idx on public.establishment (org_id, status, code);
-- At most one primary establishment per organisation.
create unique index establishment_one_primary on public.establishment (org_id) where is_primary;

alter table public.establishment enable row level security;
create policy establishment_tenant on public.establishment for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.establishment to app_user;
grant update (code, legal_name, trading_name, legal_name_local, pack_key, timezone, base_currency,
              working_days, address, invoice_identity, banking, is_primary, status,
              verification_state, verified_by, verified_at, updated_at)
  on public.establishment to app_user;
-- `country` is deliberately NOT updatable: changing the country of an
-- establishment that already carries records is a governed operation with an
-- impact preview, not a dropdown (ADR-67).
create trigger establishment_touch before update on public.establishment
  for each row execute function app.set_updated_at();

-- ── registrations (one row per number an authority issued) ──────────────────
create table public.establishment_registration (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  establishment_id uuid not null,
  -- The pack's own identifier key, e.g. 'trn', 'vat_number', 'gosi_establishment'.
  identifier_key text not null check (length(identifier_key) between 1 and 60),
  kind text not null check (kind in ('tax_registration', 'commercial_registration',
                                     'payroll_establishment', 'national_id', 'other')),
  authority text not null check (length(authority) between 1 and 200),
  -- Stored exactly as entered; validation is pack-driven and permissive.
  value text not null check (length(value) between 1 and 80),
  issued_on date,
  expires_on date,
  verification_state text not null default 'unverified'
    check (verification_state in ('unverified', 'self_declared', 'verified')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint establishment_registration_id_org_uq unique (id, org_id),
  constraint establishment_registration_fk foreign key (establishment_id, org_id)
    references public.establishment (id, org_id) on delete restrict,
  constraint establishment_registration_uq unique (org_id, establishment_id, identifier_key),
  check (expires_on is null or issued_on is null or expires_on >= issued_on)
);
create index establishment_registration_idx
  on public.establishment_registration (org_id, establishment_id, kind);
alter table public.establishment_registration enable row level security;
create policy establishment_registration_tenant on public.establishment_registration for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.establishment_registration to app_user;
grant update (value, authority, issued_on, expires_on, verification_state, updated_at)
  on public.establishment_registration to app_user;
create trigger establishment_registration_touch before update on public.establishment_registration
  for each row execute function app.set_updated_at();

-- ── adoption (append-only: what applied, from when, decided by whom) ────────
create table public.establishment_pack_adoption (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  establishment_id uuid not null,
  pack_key text not null references public.country_pack (pack_key),
  -- The date from which this establishment uses the version. Never backdated
  -- before the pack's own effective_from.
  effective_from date not null,
  adopted_by uuid not null references public.user_profile (id),
  -- The impact preview the person saw before adopting.
  impact jsonb not null default '{}'::jsonb,
  note text check (note is null or length(note) <= 1000),
  -- A later row supersedes an earlier one; nothing is ever edited.
  superseded_by uuid references public.establishment_pack_adoption (id),
  created_at timestamptz not null default now(),
  constraint establishment_pack_adoption_id_org_uq unique (id, org_id),
  constraint establishment_pack_adoption_fk foreign key (establishment_id, org_id)
    references public.establishment (id, org_id) on delete restrict,
  constraint establishment_pack_adoption_uq unique (org_id, establishment_id, pack_key, effective_from)
);
create index establishment_pack_adoption_idx
  on public.establishment_pack_adoption (org_id, establishment_id, effective_from desc);
alter table public.establishment_pack_adoption enable row level security;
create policy establishment_pack_adoption_tenant on public.establishment_pack_adoption for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
-- Insert and read only: an adoption is history. `superseded_by` is the single
-- updatable column, which is how a later adoption closes an earlier one.
grant select, insert on public.establishment_pack_adoption to app_user;
grant update (superseded_by) on public.establishment_pack_adoption to app_user;

-- ── the pack a date resolves to, in the database ────────────────────────────
-- The same law as src/platform/country/registry.ts, so a report written in SQL
-- and a screen written in TypeScript cannot disagree.
create or replace function app.establishment_pack_on(
  p_establishment uuid,
  p_on date
) returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select a.pack_key
  from public.establishment_pack_adoption a
  join public.country_pack p on p.pack_key = a.pack_key
  where a.establishment_id = p_establishment
    and a.effective_from <= p_on
    and p_on >= p.effective_from
    and (p.effective_to is null or p_on < p.effective_to)
  order by a.effective_from desc, a.created_at desc
  limit 1;
$$;

-- ── operator-only writes to the global registry ────────────────────────────
-- Pack rows and review states are platform data. No organisation role can
-- change them; the platform operator (H28's `platform_operator`) can.
create or replace function app.country_pack_upsert(
  p_pack_key text,
  p_country text,
  p_jurisdiction text,
  p_version text,
  p_status text,
  p_effective_from date,
  p_effective_to date,
  p_supersedes text,
  p_currency text,
  p_default_timezone text,
  p_supported_languages jsonb,
  p_sources jsonb,
  p_known_limitations jsonb,
  p_change_history jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_operator();
  insert into public.country_pack (pack_key, country, jurisdiction, version, status,
    effective_from, effective_to, supersedes, currency, default_timezone,
    supported_languages, sources, known_limitations, change_history)
  values (p_pack_key, p_country, p_jurisdiction, p_version, p_status,
    p_effective_from, p_effective_to, p_supersedes, p_currency, p_default_timezone,
    coalesce(p_supported_languages, '[]'::jsonb), coalesce(p_sources, '[]'::jsonb),
    coalesce(p_known_limitations, '[]'::jsonb), coalesce(p_change_history, '[]'::jsonb))
  on conflict (pack_key) do update set
    jurisdiction = excluded.jurisdiction,
    version = excluded.version,
    status = excluded.status,
    effective_from = excluded.effective_from,
    effective_to = excluded.effective_to,
    supersedes = excluded.supersedes,
    currency = excluded.currency,
    default_timezone = excluded.default_timezone,
    supported_languages = excluded.supported_languages,
    sources = excluded.sources,
    known_limitations = excluded.known_limitations,
    change_history = excluded.change_history,
    updated_at = now();

  insert into public.platform_audit (actor_user_id, action, scope, scope_key, summary, after_data)
  values ((select app.current_user_id()), 'country_pack.upsert', 'country_pack', p_pack_key,
          format('pack %s set to %s effective %s', p_pack_key, p_status, p_effective_from),
          jsonb_build_object('status', p_status, 'effective_from', p_effective_from,
                             'effective_to', p_effective_to));
end;
$$;

create or replace function app.country_pack_review_set(
  p_pack_key text,
  p_kind text,
  p_state text,
  p_reviewer text,
  p_note text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_operator();
  insert into public.country_pack_review (pack_key, kind, state, reviewer, note, decided_at)
  values (p_pack_key, p_kind, p_state, p_reviewer, p_note,
          case when p_state in ('passed', 'failed') then now() else null end)
  on conflict (pack_key, kind) do update set
    state = excluded.state,
    reviewer = excluded.reviewer,
    note = excluded.note,
    decided_at = excluded.decided_at,
    updated_at = now();

  insert into public.platform_audit (actor_user_id, action, scope, scope_key, summary, after_data)
  values ((select app.current_user_id()), 'country_pack.review', 'country_pack', p_pack_key,
          format('%s review of %s is %s', p_kind, p_pack_key, p_state),
          jsonb_build_object('kind', p_kind, 'state', p_state, 'reviewer', p_reviewer));
end;
$$;

revoke all on function app.country_pack_upsert(text, text, text, text, text, date, date, text, text, text, jsonb, jsonb, jsonb, jsonb) from public;
revoke all on function app.country_pack_review_set(text, text, text, text, text) from public;
grant execute on function app.country_pack_upsert(text, text, text, text, text, date, date, text, text, text, jsonb, jsonb, jsonb, jsonb) to app_user;
grant execute on function app.country_pack_review_set(text, text, text, text, text) to app_user;
grant execute on function app.establishment_pack_on(uuid, date) to app_user;
