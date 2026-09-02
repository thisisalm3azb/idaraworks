-- 0117_h26f_signature_room (H26 — the signature room, ADR-21/23).
--
-- A signature REQUEST binds an issued snapshot to an ordered set of SIGNERS.
-- Members sign in-app; external signers receive a one-time invitation: 32
-- random bytes, only the SHA-256 stored, expiring, revocable, single use.
-- The public signing path never touches app_user's tenant policies directly:
-- a SECURITY DEFINER resolver returns the one signer a token entitles the
-- caller to (the document_share precedent, 0083), and the route then works
-- under a synthetic org context. Every signature carries an evidence record
-- (hashed) and appends to the document's hash-chained timeline.
--
-- Claim policy (truth map part C): this is an ELECTRONIC signature with an
-- evidence record. No certificate, no qualified time stamp. The provider
-- column names the adapter; only `native` exists.

create table public.doc_signature_request (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  document_id uuid not null,
  snapshot_id uuid not null,
  provider text not null default 'native' check (provider in ('native')),
  mode text not null default 'parallel' check (mode in ('sequential', 'parallel')),
  status text not null default 'pending' check (status in (
    'pending', 'in_progress', 'completed', 'declined', 'cancelled', 'expired'
  )),
  message text check (message is null or length(message) <= 2000),
  expires_at timestamptz not null,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 1000),
  row_version bigint not null default 1,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint doc_signature_request_id_org_uq unique (id, org_id),
  constraint doc_signature_request_document_fk foreign key (document_id, org_id)
    references public.doc_document (id, org_id) on delete restrict,
  constraint doc_signature_request_snapshot_fk foreign key (snapshot_id, org_id)
    references public.doc_snapshot (id, org_id) on delete restrict,
  constraint doc_signature_request_expiry_ck check (expires_at > created_at)
);
create unique index doc_signature_request_one_live_idx on public.doc_signature_request (document_id)
  where status in ('pending', 'in_progress');
create index doc_signature_request_org_idx on public.doc_signature_request (org_id, document_id, created_at desc);
alter table public.doc_signature_request enable row level security;
create policy doc_signature_request_select on public.doc_signature_request
  for select to app_user using (org_id = (select app.current_org_id()));
create policy doc_signature_request_insert on public.doc_signature_request
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy doc_signature_request_update on public.doc_signature_request
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.doc_signature_request to app_user;
grant update (status, message, expires_at, completed_at, cancelled_at, cancel_reason,
              row_version, updated_at)
  on public.doc_signature_request to app_user;

create table public.doc_signer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  request_id uuid not null,
  document_id uuid not null,
  order_index integer not null default 0 check (order_index >= 0),
  -- The signature block party this person signs for (matched by label).
  party text not null check (party ~ '^[A-Za-z0-9_ -]{1,40}$'),
  party_kind text not null check (party_kind in ('member', 'external')),
  user_id uuid references public.user_profile (id),
  name text not null check (length(trim(name)) between 1 and 200),
  email text check (email is null or (length(email) <= 320 and position('@' in email) > 1)),
  title text check (title is null or length(title) <= 120),
  status text not null default 'pending' check (status in (
    'pending', 'invited', 'viewed', 'signed', 'declined', 'revoked', 'expired'
  )),
  -- One-time invitation: only the SHA-256 of the token is stored.
  token_hash text,
  token_expires_at timestamptz,
  invited_at timestamptz,
  delivery text check (delivery is null or delivery in ('email', 'link', 'in_app')),
  viewed_at timestamptz,
  signed_at timestamptz,
  declined_at timestamptz,
  decline_reason text check (decline_reason is null or length(decline_reason) <= 1000),
  signature_kind text check (signature_kind is null or signature_kind in ('typed', 'drawn')),
  -- Typed name, or an SVG path for a drawn signature (bounded).
  signature_data text check (signature_data is null or length(signature_data) <= 20000),
  -- Evidence: identity as asserted, verification method, server time, ip,
  -- user agent, locale, consent text version, the snapshot hash.
  evidence jsonb,
  evidence_hash text check (evidence_hash is null or evidence_hash ~ '^[0-9a-f]{64}$'),
  reminder_count integer not null default 0 check (reminder_count >= 0),
  last_reminded_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.user_profile (id),
  row_version bigint not null default 1,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint doc_signer_id_org_uq unique (id, org_id),
  constraint doc_signer_token_uq unique (token_hash),
  constraint doc_signer_request_fk foreign key (request_id, org_id)
    references public.doc_signature_request (id, org_id) on delete restrict,
  constraint doc_signer_document_fk foreign key (document_id, org_id)
    references public.doc_document (id, org_id) on delete restrict,
  constraint doc_signer_member_ck
    check ((party_kind = 'member') = (user_id is not null)),
  constraint doc_signer_signed_ck
    check ((status = 'signed') = (signed_at is not null and evidence_hash is not null))
);
create index doc_signer_request_idx on public.doc_signer (org_id, request_id, order_index);
create index doc_signer_live_token_idx on public.doc_signer (token_hash)
  where token_hash is not null and revoked_at is null;
create index doc_signer_user_idx on public.doc_signer (org_id, user_id) where status in ('pending', 'invited', 'viewed');
alter table public.doc_signer enable row level security;
create policy doc_signer_select on public.doc_signer
  for select to app_user using (org_id = (select app.current_org_id()));
create policy doc_signer_insert on public.doc_signer
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy doc_signer_update on public.doc_signer
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.doc_signer to app_user;
grant update (status, token_hash, token_expires_at, invited_at, delivery, viewed_at, signed_at,
              declined_at, decline_reason, signature_kind, signature_data, evidence, evidence_hash,
              reminder_count, last_reminded_at, revoked_at, revoked_by, title, row_version, updated_at)
  on public.doc_signer to app_user;

-- A signed row never changes again (the evidence is what a receipt points at).
create or replace function app.doc_signer_guard()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'signed' then
    raise exception 'H26: a signed signer row is immutable'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;
create trigger doc_signer_guard
  before update on public.doc_signer
  for each row execute function app.doc_signer_guard();

create trigger doc_signature_request_touch before update on public.doc_signature_request
  for each row execute function app.set_updated_at();
create trigger doc_signer_touch before update on public.doc_signer
  for each row execute function app.set_updated_at();

-- ── the public resolver: one token, one signer, nothing else ────────────────
-- Returns nothing for unknown, revoked, expired or already-used tokens, and
-- when the request itself is no longer live, so a caller cannot tell those
-- apart. Restates every liveness rule rather than trusting earlier gates.
create or replace function app.resolve_doc_signer(p_token_hash text)
returns table (
  signer_id uuid,
  org_id uuid,
  document_id uuid,
  request_id uuid,
  status text,
  party text,
  name text,
  email text,
  order_index integer,
  request_mode text,
  request_expires_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select s.id, s.org_id, s.document_id, s.request_id, s.status, s.party, s.name, s.email,
         s.order_index, r.mode, r.expires_at
  from public.doc_signer s
  join public.doc_signature_request r on r.id = s.request_id and r.org_id = s.org_id
  where s.token_hash = p_token_hash
    and s.revoked_at is null
    and s.status in ('invited', 'viewed')
    and (s.token_expires_at is null or s.token_expires_at > now())
    and r.status in ('pending', 'in_progress')
    and r.expires_at > now()
  limit 1;
$$;
revoke all on function app.resolve_doc_signer(text) from public;
grant execute on function app.resolve_doc_signer(text) to app_user;

comment on table public.doc_signature_request is
  'H26: one round of signatures over one immutable snapshot. Signers are ordered; the request completes when every signer signed.';
comment on table public.doc_signer is
  'H26: one signing party. Members sign in-app; external parties use a one-time hashed invitation. A signed row is immutable and carries its evidence record.';
