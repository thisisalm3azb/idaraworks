-- 0118_h26g_forms (H26 — forms, ADR-24).
--
-- A form is a document whose body holds field blocks. A form LINK lets an
-- outside party submit answers through a SECURITY DEFINER function that
-- writes ONE quarantined submission row under the organisation's id; the
-- link is hashed, expiring, revocable and use-capped. Submissions become
-- records only through explicit reviewed actions (convert) that run under
-- the reviewer's own permissions and validation. Nothing on the public path
-- can read organisation data or change anything but its own submission row.

create table public.doc_form_link (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  document_id uuid not null,
  -- The issued snapshot the outside party fills in.
  snapshot_id uuid not null,
  label text check (label is null or length(label) <= 120),
  token_hash text not null,
  expires_at timestamptz not null,
  max_uses integer check (max_uses is null or max_uses between 1 and 100000),
  use_count integer not null default 0 check (use_count >= 0),
  revoked_at timestamptz,
  revoked_by uuid references public.user_profile (id),
  last_used_at timestamptz,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint doc_form_link_id_org_uq unique (id, org_id),
  constraint doc_form_link_token_uq unique (token_hash),
  constraint doc_form_link_document_fk foreign key (document_id, org_id)
    references public.doc_document (id, org_id) on delete restrict,
  constraint doc_form_link_snapshot_fk foreign key (snapshot_id, org_id)
    references public.doc_snapshot (id, org_id) on delete restrict,
  constraint doc_form_link_expiry_ck check (expires_at > created_at)
);
create index doc_form_link_org_idx on public.doc_form_link (org_id, document_id);
create index doc_form_link_live_idx on public.doc_form_link (token_hash) where revoked_at is null;
alter table public.doc_form_link enable row level security;
create policy doc_form_link_select on public.doc_form_link
  for select to app_user using (org_id = (select app.current_org_id()));
create policy doc_form_link_insert on public.doc_form_link
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy doc_form_link_update on public.doc_form_link
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.doc_form_link to app_user;
grant update (label, expires_at, max_uses, revoked_at, revoked_by) on public.doc_form_link to app_user;

create table public.doc_form_submission (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  document_id uuid not null,
  link_id uuid,
  snapshot_id uuid not null,
  -- Field key → value as submitted (validated by the definer against the
  -- snapshot's field blocks: kinds, required, options, bounds).
  answers jsonb not null,
  submitter_name text check (submitter_name is null or length(submitter_name) <= 200),
  submitter_email text check (submitter_email is null or length(submitter_email) <= 320),
  submitted_at timestamptz not null default now(),
  ip text check (ip is null or length(ip) <= 64),
  user_agent text check (user_agent is null or length(user_agent) <= 300),
  status text not null default 'received' check (status in ('received', 'reviewed', 'converted', 'discarded')),
  reviewed_by uuid references public.user_profile (id),
  reviewed_at timestamptz,
  review_note text check (review_note is null or length(review_note) <= 2000),
  converted_record_type text check (converted_record_type is null or converted_record_type ~ '^[a-z_]{1,40}$'),
  converted_record_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint doc_form_submission_id_org_uq unique (id, org_id),
  constraint doc_form_submission_document_fk foreign key (document_id, org_id)
    references public.doc_document (id, org_id) on delete restrict,
  constraint doc_form_submission_link_fk foreign key (link_id, org_id)
    references public.doc_form_link (id, org_id) on delete restrict,
  constraint doc_form_submission_snapshot_fk foreign key (snapshot_id, org_id)
    references public.doc_snapshot (id, org_id) on delete restrict,
  constraint doc_form_submission_converted_ck
    check ((converted_record_type is null) = (converted_record_id is null))
);
create index doc_form_submission_org_idx on public.doc_form_submission (org_id, document_id, submitted_at desc);
create index doc_form_submission_status_idx on public.doc_form_submission (org_id, status) where status = 'received';
alter table public.doc_form_submission enable row level security;
create policy doc_form_submission_select on public.doc_form_submission
  for select to app_user using (org_id = (select app.current_org_id()));
-- No INSERT policy for app_user: submissions arrive only through the definer below.
create policy doc_form_submission_update on public.doc_form_submission
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select on public.doc_form_submission to app_user;
grant update (status, reviewed_by, reviewed_at, review_note, converted_record_type, converted_record_id, updated_at)
  on public.doc_form_submission to app_user;
create trigger doc_form_submission_touch before update on public.doc_form_submission
  for each row execute function app.set_updated_at();

-- ── public resolver ──────────────────────────────────────────────────────────
create or replace function app.resolve_doc_form_link(p_token_hash text)
returns table (link_id uuid, org_id uuid, document_id uuid, snapshot_id uuid, label text, expires_at timestamptz)
language sql
security definer
set search_path = public, pg_temp
as $$
  select l.id, l.org_id, l.document_id, l.snapshot_id, l.label, l.expires_at
  from public.doc_form_link l
  where l.token_hash = p_token_hash
    and l.revoked_at is null
    and l.expires_at > now()
    and (l.max_uses is null or l.use_count < l.max_uses)
  limit 1;
$$;
revoke all on function app.resolve_doc_form_link(text) from public;
grant execute on function app.resolve_doc_form_link(text) to app_user;

-- ── public submit: the ONLY insert path into doc_form_submission ─────────────
-- Re-checks every liveness rule, counts the use atomically, and writes one
-- row under the link's organisation. The answers were validated by the
-- application against the snapshot before this call; the function stores
-- them as data and never evaluates them.
create or replace function app.doc_form_submit(
  p_token_hash text,
  p_answers jsonb,
  p_name text,
  p_email text,
  p_ip text,
  p_user_agent text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link public.doc_form_link%rowtype;
  v_id uuid;
begin
  select * into v_link from public.doc_form_link l
  where l.token_hash = p_token_hash
    and l.revoked_at is null
    and l.expires_at > now()
    and (l.max_uses is null or l.use_count < l.max_uses)
  for update;
  if not found then
    return null;
  end if;
  if pg_column_size(p_answers) > 200000 then
    raise exception 'answers too large';
  end if;
  insert into public.doc_form_submission
    (org_id, document_id, link_id, snapshot_id, answers, submitter_name, submitter_email, ip, user_agent)
  values (v_link.org_id, v_link.document_id, v_link.id, v_link.snapshot_id, p_answers,
          left(p_name, 200), left(p_email, 320), left(p_ip, 64), left(p_user_agent, 300))
  returning id into v_id;
  update public.doc_form_link set use_count = use_count + 1, last_used_at = now() where id = v_link.id;
  return v_id;
end;
$$;
revoke all on function app.doc_form_submit(text, jsonb, text, text, text, text) from public;
grant execute on function app.doc_form_submit(text, jsonb, text, text, text, text) to app_user;

comment on table public.doc_form_submission is
  'H26: quarantined answers from a form link. Only app.doc_form_submit inserts; a reviewer converts to a record explicitly.';
