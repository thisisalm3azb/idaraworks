-- 0082_document_foundation (H22.0 — the storage the document system was missing)
--
-- 003B.1 designed the document foundation and left three things for the phase
-- that adds the first print routes, which this is:
--
--   1. Nowhere to STORE an issuer snapshot. issuer.ts defines the contract and
--      captureIssuerSnapshot() builds one, but no column in any of the 81 prior
--      migrations holds the result, so an issued document could not keep the
--      identity it was issued under.
--   2. No weekly plan record. The week was a derived view over jobs and tasks,
--      so there was nothing to issue, number or revise.
--   3. No way to share a document outside the application.
--
-- Nothing here duplicates an existing model: quote and invoice already carry
-- their own numbering, status vocabulary and revision lineage (quote.revision_of_id,
-- invoice.corrects_invoice_id) and are extended in place.

-- ── 1. Issuer snapshots on the documents that are issued ────────────────────
-- Nullable on purpose. Rows that predate this migration have no snapshot and
-- render through legacyIssuerFallback(); back-filling the CURRENT identity onto
-- an old document would be inventing history, which is exactly what the
-- snapshot exists to prevent.
--
-- jsonb, validated by the IssuerSnapshot zod contract on the way in. A CHECK
-- constraint here would duplicate that contract in a second dialect and drift
-- from it; what the database does enforce is that a snapshot, once written, is
-- never silently replaced (the writers use `where issuer_snapshot is null`).
alter table public.quote
  add column issuer_snapshot jsonb,
  add column issued_at timestamptz;

alter table public.invoice
  add column issuer_snapshot jsonb;

comment on column public.quote.issuer_snapshot is
  'Immutable issuer identity captured when the quotation was first issued (IssuerSnapshot v1). Null for rows issued before H22.0 — those render through legacyIssuerFallback.';
comment on column public.invoice.issuer_snapshot is
  'Immutable issuer identity captured when the invoice was issued (IssuerSnapshot v1). Null for rows issued before H22.0.';

grant update (issuer_snapshot, issued_at) on public.quote to app_user;
grant update (issuer_snapshot) on public.invoice to app_user;

-- ── 2. The weekly plan ──────────────────────────────────────────────────────
-- A real record, so a week can be issued, numbered and revised like any other
-- document. It does not duplicate the work model: it REFERENCES the jobs and
-- tasks that already exist and adds only what a plan needs — which week, who is
-- responsible, and the notes and approval that make it a document.
create table public.week_plan (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,
  -- The Monday of the week. A date, not a timestamp: a plan belongs to a week
  -- in the organization's own calendar, not to an instant.
  week_start date not null,
  week_end date not null,
  title text check (title is null or length(title) between 1 and 200),
  manager_user_id uuid references public.user_profile (id),
  notes text check (notes is null or length(notes) <= 4000),
  -- Same four structural states every issued document has.
  status text not null default 'draft'
    check (status in ('draft', 'issued', 'revised', 'cancelled')),
  issued_at timestamptz,
  issued_by uuid references public.user_profile (id),
  cancelled_reason text check (cancelled_reason is null or length(cancelled_reason) between 1 and 500),
  -- Revision lineage, mirroring quote.revision_of_id.
  revision_of_id uuid,
  revision_reason text check (revision_reason is null or length(revision_reason) between 1 and 500),
  issuer_snapshot jsonb,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint week_plan_id_org_uq unique (id, org_id),
  constraint week_plan_week_ck check (week_end >= week_start),
  -- An issued plan must record when and by whom; a draft must not pretend to.
  constraint week_plan_issued_ck check (
    (status = 'draft' and issued_at is null and issued_by is null)
    or (status <> 'draft' and issued_at is not null and issued_by is not null)
  ),
  constraint week_plan_cancel_ck check (status <> 'cancelled' or cancelled_reason is not null),
  constraint week_plan_revision_ck check (revision_of_id is null or revision_reason is not null)
);

alter table public.week_plan
  add constraint week_plan_revision_fk
  foreign key (revision_of_id, org_id) references public.week_plan (id, org_id) on delete restrict;

-- One reference per org, and one LIVE plan per week per org: a superseded
-- revision keeps its row, so the partial index counts only what is current.
create unique index week_plan_reference_uq on public.week_plan (org_id, reference);
create unique index week_plan_live_week_uq on public.week_plan (org_id, week_start)
  where status in ('draft', 'issued');
create index week_plan_org_status_idx on public.week_plan (org_id, status, week_start desc);

alter table public.week_plan enable row level security;
create policy week_plan_select on public.week_plan
  for select to app_user using (org_id = (select app.current_org_id()));
create policy week_plan_insert on public.week_plan
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy week_plan_update on public.week_plan
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.week_plan to app_user;
grant update (title, manager_user_id, notes, status, issued_at, issued_by,
              cancelled_reason, issuer_snapshot, revision_of_id, revision_reason, updated_at)
  on public.week_plan to app_user;
-- No DELETE: a plan is archived by status, never removed.

-- The work a plan covers. A link table, so the plan never copies job data it
-- does not own — the document renders from the live job/task rows at render
-- time, and the plan records only WHICH work it covers.
create table public.week_plan_job (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  week_plan_id uuid not null,
  job_id uuid not null,
  sort integer not null default 0,
  note text check (note is null or length(note) <= 500),
  -- Taking work off a draft marks the row rather than deleting it, so the app
  -- role needs no DELETE grant here. Readers filter on this being null.
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint week_plan_job_plan_fk foreign key (week_plan_id, org_id)
    references public.week_plan (id, org_id) on delete restrict,
  constraint week_plan_job_job_fk foreign key (job_id, org_id)
    references public.job (id, org_id) on delete restrict,
  constraint week_plan_job_uq unique (week_plan_id, job_id)
);
create index week_plan_job_org_plan_idx on public.week_plan_job (org_id, week_plan_id);
alter table public.week_plan_job enable row level security;
create policy week_plan_job_select on public.week_plan_job
  for select to app_user using (org_id = (select app.current_org_id()));
create policy week_plan_job_insert on public.week_plan_job
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy week_plan_job_update on public.week_plan_job
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.week_plan_job to app_user;
grant update (sort, note, removed_at) on public.week_plan_job to app_user;
-- No DELETE grant, here or anywhere (D-1.7). Editing a draft's covered work
-- marks rows removed and revives them on re-selection, so the plan's history
-- survives and no code path can destroy the lines of an ISSUED document even
-- by mistake. The service refuses edits after issue as well; this is the layer
-- that holds when the service is wrong.

-- ── 3. Share links ──────────────────────────────────────────────────────────
-- A revocable, expiring, single-document link. The token is stored HASHED: a
-- leaked database backup must not become a set of working document URLs, so the
-- plaintext token exists only in the URL handed to the person sharing it.
create table public.document_share (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  /*
   * Which document. Kept as (type, id) rather than a column per type so a new
   * document type needs no schema change.
   *
   * The list is the EXTERNALLY SHAREABLE kinds only. A weekly work plan renders
   * employee names against tasks and covers every job that week, so one
   * customer's link would show them another customer's work; it is refused here,
   * in the minting service, in the resolver and in the public route. This is the
   * layer that holds when the others are wrong, so adding a kind means deciding
   * again, in SQL, that it may leave the organization.
   */
  subject_type text not null
    constraint document_share_subject_type_ck check (subject_type in ('quote', 'invoice')),
  /*
   * The document itself. A plain foreign key cannot express this because the
   * target table depends on subject_type, so a trigger validates it below:
   * without that, subject_id is an unvalidated uuid and a share could point at
   * nothing, at another organization's record, or at a row of the wrong type.
   */
  subject_id uuid not null,
  -- SHA-256 of the token. Unique so a lookup is a single indexed probe.
  token_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references public.user_profile (id),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  last_viewed_at timestamptz,
  view_count integer not null default 0 check (view_count >= 0),
  constraint document_share_token_uq unique (token_hash),
  constraint document_share_expiry_ck check (expires_at > created_at)
);
create index document_share_org_subject_idx
  on public.document_share (org_id, subject_type, subject_id);
-- The live-link probe: unexpired and unrevoked.
create index document_share_live_idx on public.document_share (token_hash)
  where revoked_at is null;

alter table public.document_share enable row level security;
-- Members of the owning organization manage their own share links. The PUBLIC
-- read path never uses app_user: it resolves the token with the service role in
-- a server route, checks expiry and revocation there, and returns only the one
-- document. No policy grants anonymous access to this table.
create policy document_share_select on public.document_share
  for select to app_user using (org_id = (select app.current_org_id()));
create policy document_share_insert on public.document_share
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy document_share_revoke on public.document_share
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.document_share to app_user;
grant update (revoked_at, revoked_by) on public.document_share to app_user;
-- No DELETE: revoking is a state change that stays in the record.

/*
 * Polymorphic reference integrity for document_share.subject_id.
 *
 * (subject_type, subject_id) points into a different table per type, which no
 * foreign key can express, so the check is a trigger. It confirms three things
 * together, because any one alone is insufficient:
 *   - the referenced record EXISTS
 *   - it belongs to the SAME organization as the share
 *   - its table AGREES with subject_type
 *
 * SECURITY DEFINER so the answer does not depend on who is inserting or on
 * whether a tenancy GUC happens to be set: the org match is asserted explicitly
 * against the row's own org_id rather than inferred from RLS being active. A
 * cross-organization subject therefore fails on the explicit predicate, not by
 * being invisible, and fails identically for app_user and for the service role.
 *
 * search_path is pinned, as any SECURITY DEFINER function must be, so the
 * tables it resolves cannot be shadowed by a caller's search_path.
 */
create function app.validate_document_share_subject()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  subject_exists boolean;
begin
  if new.subject_type = 'quote' then
    select exists (
      select 1 from public.quote q
      where q.id = new.subject_id and q.org_id = new.org_id
    ) into subject_exists;
  elsif new.subject_type = 'invoice' then
    select exists (
      select 1 from public.invoice i
      where i.id = new.subject_id and i.org_id = new.org_id
    ) into subject_exists;
  else
    -- Unreachable while the check constraint stands; kept so that relaxing the
    -- constraint without teaching this function fails closed rather than open.
    raise exception 'document_share: % is not an externally shareable document type',
      new.subject_type
      using errcode = 'check_violation';
  end if;

  if not subject_exists then
    -- One message for "no such record" and "another organization's record": the
    -- difference is not something an error should disclose.
    raise exception 'document_share: no % in this organization for the given subject_id',
      new.subject_type
      using errcode = 'foreign_key_violation';
  end if;

  return new;
end;
$$;

revoke all on function app.validate_document_share_subject() from public;

-- Fires on insert and on any change to the three columns that together decide
-- what the share points at. app_user cannot update those columns at all, but a
-- privileged path could, and this is the layer that does not depend on grants.
create trigger document_share_subject_validate
  before insert or update of subject_type, subject_id, org_id
  on public.document_share
  for each row execute function app.validate_document_share_subject();
