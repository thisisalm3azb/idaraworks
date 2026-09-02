-- 0114_h26a_document_foundation (H26 — Document Studio: the authored document
-- object, its revisions, the immutable issued snapshot, the hash-chained
-- evidence timeline, governed templates with versions, reusable workflow
-- definitions, folders, saved views and anchored comments).
--
-- ONE DOCUMENT OBJECT (ADR-19/20): the existing 22 document kinds stay derived
-- prints of their records. This migration adds the AUTHORED document: content
-- lives in revisions, exactly one of which is `working` (editable); freezing a
-- revision records its content hash; issuing writes ONE snapshot that the
-- database itself refuses to change. A signed or active document is never
-- edited — a successor supersedes it.
--
-- House laws throughout: org_id + RLS on every table, composite (id, org_id)
-- pins on every cross-table reference, column-scoped UPDATE grants, author
-- backstop on INSERT, and NO DELETE grants — removal is soft or archival.

-- ── the documents capability (same law as cap.studio in 0107): enabled on
-- every plan; surfaces stay invisible behind FEATURE_DOCUMENT_STUDIO until
-- verified end to end. Mirrors entitlements/catalogue.ts (parity test).
insert into public.entitlement_def (key, kind) values ('cap.documents', 'feature');
insert into public.plan_entitlement (plan_key, entitlement_key, enabled)
select p.key, 'cap.documents', true
from public.plan p
where p.key in ('free', 'starter', 'growth', 'business');

-- ── file access class `document_file` (ADR-29) ───────────────────────────────
-- Supporting papers and signed scans attach to a document. Read follows the
-- documents.view lane (every archetype but foreman); write follows the
-- documents.edit lane. Mirrored in src/platform/files/access.ts (parity test).
alter table public.file drop constraint file_access_class_check;
alter table public.file
  add constraint file_access_class_check check (
    access_class in ('job_media', 'financial_doc', 'hr_doc', 'customer_share', 'document_file')
  );

create or replace function app.can_access_file_class(
  p_org uuid,
  p_user uuid,
  p_class text,
  p_write boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.membership m
    join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
    where m.org_id = p_org
      and m.user_id = p_user
      and m.deactivated_at is null
      and case p_class
        when 'job_media' then
          (not p_write) or r.archetype in ('owner', 'admin', 'manager', 'foreman')
        when 'financial_doc' then
          case when p_write
            then r.archetype in ('owner', 'admin', 'manager', 'procurement', 'accounts')
            else r.price_privileged
          end
        when 'hr_doc' then r.archetype in ('owner', 'admin')
        -- H26: document papers. Read = documents.view lane; write = documents.edit lane.
        when 'document_file' then
          case when p_write
            then r.archetype in ('owner', 'admin', 'manager', 'procurement', 'accounts')
            else r.archetype in ('owner', 'admin', 'manager', 'procurement', 'accounts', 'viewer')
          end
        else false
      end
  )
$$;
revoke all on function app.can_access_file_class(uuid, uuid, text, boolean) from public;
grant execute on function app.can_access_file_class(uuid, uuid, text, boolean) to app_user, authenticated;

-- The storage insert wall maps the new class to the documents bucket. Only
-- where the storage schema exists (the CI stack has it; guarded anyway).
do $$
begin
  if to_regclass('storage.objects') is not null then
    execute $p$drop policy if exists tenant_objects_insert on storage.objects$p$;
    execute $p$create policy tenant_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('tenant-media', 'tenant-docs')
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and bucket_id = case
      when (storage.foldername(name))[2] in ('job_media', 'customer_share') then 'tenant-media'
      when (storage.foldername(name))[2] in ('financial_doc', 'hr_doc', 'document_file') then 'tenant-docs'
      else ''
    end
    and app.can_access_file_class(
      ((storage.foldername(name))[1])::uuid,
      (select auth.uid()),
      (storage.foldername(name))[2],
      true
    )
  )$p$;
  end if;
end $$;

-- ── immutability guard shared by the frozen tables ───────────────────────────
create or replace function app.doc_reject_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'H26: % rows are immutable', tg_table_name
    using errcode = 'integrity_constraint_violation';
end;
$$;

-- ── folders ──────────────────────────────────────────────────────────────────
create table public.doc_folder (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 120),
  parent_id uuid,
  archived_at timestamptz,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint doc_folder_id_org_uq unique (id, org_id),
  constraint doc_folder_parent_fk foreign key (parent_id, org_id)
    references public.doc_folder (id, org_id) on delete restrict
);
create index doc_folder_org_idx on public.doc_folder (org_id, parent_id) where archived_at is null;
alter table public.doc_folder enable row level security;
create policy doc_folder_select on public.doc_folder
  for select to app_user using (org_id = (select app.current_org_id()));
create policy doc_folder_insert on public.doc_folder
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy doc_folder_update on public.doc_folder
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.doc_folder to app_user;
grant update (name, parent_id, archived_at, updated_at) on public.doc_folder to app_user;

-- ── workflow definitions (ADR-22) ────────────────────────────────────────────
-- A reusable, visually designed sequence of review / approval / signature
-- steps with conditions. Runs COPY the definition (0115), so editing a
-- workflow never rewrites an in-flight run.
create table public.doc_workflow (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 160),
  description text check (description is null or length(description) <= 2000),
  definition jsonb not null default '{"steps":[]}',
  status text not null default 'active' check (status in ('active', 'retired')),
  row_version bigint not null default 1,
  created_by uuid not null references public.user_profile (id),
  updated_by uuid references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint doc_workflow_id_org_uq unique (id, org_id)
);
create index doc_workflow_org_idx on public.doc_workflow (org_id, status, updated_at desc);
alter table public.doc_workflow enable row level security;
create policy doc_workflow_select on public.doc_workflow
  for select to app_user using (org_id = (select app.current_org_id()));
create policy doc_workflow_insert on public.doc_workflow
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy doc_workflow_update on public.doc_workflow
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.doc_workflow to app_user;
grant update (name, description, definition, status, row_version, updated_by, updated_at)
  on public.doc_workflow to app_user;

-- ── templates and their versions ─────────────────────────────────────────────
create table public.doc_template (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  key text not null check (key ~ '^[a-z0-9_.-]{1,60}$'),
  name_en text not null check (length(trim(name_en)) between 1 and 160),
  name_ar text not null check (length(trim(name_ar)) between 1 and 160),
  category text not null check (category in (
    'contract', 'agreement', 'letter', 'proposal', 'policy', 'form', 'certificate', 'other'
  )),
  description text check (description is null or length(description) <= 2000),
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  current_version integer not null default 0 check (current_version >= 0),
  -- The built-in this template started from (informational; built-ins ship in code).
  builtin_key text check (builtin_key is null or builtin_key ~ '^[a-z0-9_.-]{1,60}$'),
  workflow_id uuid,
  row_version bigint not null default 1,
  created_by uuid not null references public.user_profile (id),
  updated_by uuid references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint doc_template_id_org_uq unique (id, org_id),
  constraint doc_template_key_uq unique (org_id, key),
  constraint doc_template_workflow_fk foreign key (workflow_id, org_id)
    references public.doc_workflow (id, org_id) on delete restrict
);
create index doc_template_org_idx on public.doc_template (org_id, status, category);
alter table public.doc_template enable row level security;
create policy doc_template_select on public.doc_template
  for select to app_user using (org_id = (select app.current_org_id()));
create policy doc_template_insert on public.doc_template
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy doc_template_update on public.doc_template
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.doc_template to app_user;
grant update (name_en, name_ar, category, description, status, current_version, workflow_id,
              row_version, updated_by, updated_at)
  on public.doc_template to app_user;

-- Every published version is immutable; documents pin the version they were
-- created from, so updating a template never rewrites an existing document.
create table public.doc_template_version (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  template_id uuid not null,
  version integer not null check (version >= 1),
  body jsonb not null,
  settings jsonb not null default '{}',
  change_note text check (change_note is null or length(change_note) <= 1000),
  published_at timestamptz,
  published_by uuid references public.user_profile (id),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint doc_template_version_id_org_uq unique (id, org_id),
  constraint doc_template_version_uq unique (template_id, version),
  constraint doc_template_version_template_fk foreign key (template_id, org_id)
    references public.doc_template (id, org_id) on delete restrict
);
create index doc_template_version_org_idx on public.doc_template_version (org_id, template_id, version desc);
alter table public.doc_template_version enable row level security;
create policy doc_template_version_select on public.doc_template_version
  for select to app_user using (org_id = (select app.current_org_id()));
create policy doc_template_version_insert on public.doc_template_version
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy doc_template_version_update on public.doc_template_version
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.doc_template_version to app_user;
-- A draft version may be edited and then published; a published one is frozen.
grant update (body, settings, change_note, published_at, published_by)
  on public.doc_template_version to app_user;

create or replace function app.doc_template_version_guard()
returns trigger
language plpgsql
as $$
begin
  if old.published_at is not null then
    raise exception 'H26: a published template version is immutable'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;
create trigger doc_template_version_guard
  before update on public.doc_template_version
  for each row execute function app.doc_template_version_guard();

-- ── the document ─────────────────────────────────────────────────────────────
create table public.doc_document (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,
  title text not null check (length(trim(title)) between 1 and 240),
  category text not null check (category in (
    'contract', 'agreement', 'letter', 'proposal', 'policy', 'form', 'certificate', 'other'
  )),
  language text not null default 'en' check (language in ('en', 'ar', 'bilingual')),
  status text not null default 'draft' check (status in (
    'draft', 'review', 'approval', 'signature', 'active', 'expired',
    'terminated', 'superseded', 'archived'
  )),
  folder_id uuid,
  tags text[] not null default '{}' check (cardinality(tags) <= 20),
  template_id uuid,
  template_version_id uuid,
  workflow_id uuid,
  -- The one editable revision (null once issued). Pinned after doc_revision exists.
  working_revision_id uuid,
  -- The immutable issued snapshot (0114 below). Set exactly once.
  issued_snapshot_id uuid,
  issued_at timestamptz,
  issued_by uuid references public.user_profile (id),
  effective_from date,
  expires_at date,
  -- Counterparty: validated by the service against the owning module
  -- (customer / supplier / employee). No FK: the target table varies.
  counterparty_kind text check (counterparty_kind is null or counterparty_kind in (
    'customer', 'supplier', 'employee', 'other'
  )),
  counterparty_id uuid,
  counterparty_label text check (counterparty_label is null or length(counterparty_label) <= 200),
  -- The record this document belongs to (job, quote, invoice, purchase order, lead…).
  record_type text check (record_type is null or record_type ~ '^[a-z_]{1,40}$'),
  record_id uuid,
  owner_user_id uuid references public.user_profile (id),
  supersedes_document_id uuid,
  superseded_by_document_id uuid,
  terminated_at timestamptz,
  terminated_by uuid references public.user_profile (id),
  termination_reason text check (termination_reason is null or length(termination_reason) <= 2000),
  archived_at timestamptz,
  archived_by uuid references public.user_profile (id),
  retention_until date,
  legal_hold boolean not null default false,
  -- Service-maintained plain text for search (title, reference, tags,
  -- counterparty label, body text of the latest revision). Not truth.
  search_text text not null default '',
  search tsvector generated always as (to_tsvector('simple', search_text)) stored,
  row_version bigint not null default 1,
  created_by uuid not null references public.user_profile (id),
  updated_by uuid references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint doc_document_id_org_uq unique (id, org_id),
  constraint doc_document_reference_uq unique (org_id, reference),
  constraint doc_document_folder_fk foreign key (folder_id, org_id)
    references public.doc_folder (id, org_id) on delete restrict,
  constraint doc_document_template_fk foreign key (template_id, org_id)
    references public.doc_template (id, org_id) on delete restrict,
  constraint doc_document_template_version_fk foreign key (template_version_id, org_id)
    references public.doc_template_version (id, org_id) on delete restrict,
  constraint doc_document_workflow_fk foreign key (workflow_id, org_id)
    references public.doc_workflow (id, org_id) on delete restrict,
  constraint doc_document_supersedes_fk foreign key (supersedes_document_id, org_id)
    references public.doc_document (id, org_id) on delete restrict,
  constraint doc_document_superseded_by_fk foreign key (superseded_by_document_id, org_id)
    references public.doc_document (id, org_id) on delete restrict,
  constraint doc_document_counterparty_ck
    check ((counterparty_kind is null) = (counterparty_id is null and counterparty_label is null)
           or counterparty_kind = 'other'),
  constraint doc_document_record_ck check ((record_type is null) = (record_id is null)),
  constraint doc_document_terminated_ck
    check ((status = 'terminated') = (terminated_at is not null)),
  constraint doc_document_archived_ck
    check ((status = 'archived') = (archived_at is not null))
);
create index doc_document_org_status_idx on public.doc_document (org_id, status, updated_at desc);
create index doc_document_org_folder_idx on public.doc_document (org_id, folder_id);
create index doc_document_org_record_idx on public.doc_document (org_id, record_type, record_id);
create index doc_document_org_counterparty_idx on public.doc_document (org_id, counterparty_kind, counterparty_id);
create index doc_document_org_expiry_idx on public.doc_document (org_id, expires_at)
  where status = 'active';
create index doc_document_search_idx on public.doc_document using gin (search);
create index doc_document_tags_idx on public.doc_document using gin (tags);
alter table public.doc_document enable row level security;
create policy doc_document_select on public.doc_document
  for select to app_user using (org_id = (select app.current_org_id()));
create policy doc_document_insert on public.doc_document
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy doc_document_update on public.doc_document
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.doc_document to app_user;
grant update (title, category, language, status, folder_id, tags, workflow_id,
              working_revision_id, issued_snapshot_id, issued_at, issued_by,
              effective_from, expires_at, counterparty_kind, counterparty_id,
              counterparty_label, record_type, record_id, owner_user_id,
              superseded_by_document_id, terminated_at, terminated_by,
              termination_reason, archived_at, archived_by, retention_until,
              legal_hold, search_text, row_version, updated_by, updated_at)
  on public.doc_document to app_user;

-- The issued snapshot pointer is written once. The database holds this even
-- when the service is wrong (ADR-20: never a silent change after issue).
create or replace function app.doc_document_guard()
returns trigger
language plpgsql
as $$
begin
  if old.issued_snapshot_id is not null and new.issued_snapshot_id is distinct from old.issued_snapshot_id then
    raise exception 'H26: an issued document keeps its snapshot'
      using errcode = 'integrity_constraint_violation';
  end if;
  if old.issued_snapshot_id is not null and new.working_revision_id is not null then
    raise exception 'H26: an issued document has no working revision'
      using errcode = 'integrity_constraint_violation';
  end if;
  if old.retention_until is not null and new.retention_until < old.retention_until then
    raise exception 'H26: retention can only be lengthened'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;
create trigger doc_document_guard
  before update on public.doc_document
  for each row execute function app.doc_document_guard();

-- ── revisions: content, one working, the rest frozen ─────────────────────────
create table public.doc_revision (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  document_id uuid not null,
  revision_no integer not null check (revision_no >= 1),
  state text not null default 'working' check (state in ('working', 'frozen')),
  -- The block model (validated by the service with zod; see docstudio/types.ts).
  body jsonb not null default '{"blocks":[]}',
  -- Form/calculated field values and binding configuration.
  variables jsonb not null default '{}',
  -- Header/footer/watermark/page settings.
  settings jsonb not null default '{}',
  body_text text not null default '',
  -- sha256 of the canonical body+variables+settings, set when frozen.
  content_hash text check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  based_on_revision_id uuid,
  note text check (note is null or length(note) <= 1000),
  frozen_at timestamptz,
  frozen_by uuid references public.user_profile (id),
  row_version bigint not null default 1,
  created_by uuid not null references public.user_profile (id),
  updated_by uuid references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint doc_revision_id_org_uq unique (id, org_id),
  constraint doc_revision_no_uq unique (document_id, revision_no),
  constraint doc_revision_document_fk foreign key (document_id, org_id)
    references public.doc_document (id, org_id) on delete restrict,
  constraint doc_revision_based_on_fk foreign key (based_on_revision_id, org_id)
    references public.doc_revision (id, org_id) on delete restrict,
  constraint doc_revision_frozen_ck
    check ((state = 'frozen') = (frozen_at is not null and content_hash is not null))
);
create unique index doc_revision_one_working_idx on public.doc_revision (document_id)
  where state = 'working';
create index doc_revision_org_doc_idx on public.doc_revision (org_id, document_id, revision_no desc);
create index doc_revision_body_search_idx on public.doc_revision
  using gin (to_tsvector('simple', body_text));
alter table public.doc_revision enable row level security;
create policy doc_revision_select on public.doc_revision
  for select to app_user using (org_id = (select app.current_org_id()));
create policy doc_revision_insert on public.doc_revision
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy doc_revision_update on public.doc_revision
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.doc_revision to app_user;
grant update (state, body, variables, settings, body_text, content_hash, note,
              frozen_at, frozen_by, row_version, updated_by, updated_at)
  on public.doc_revision to app_user;

create or replace function app.doc_revision_guard()
returns trigger
language plpgsql
as $$
begin
  if old.state = 'frozen' then
    raise exception 'H26: a frozen revision is immutable'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;
create trigger doc_revision_guard
  before update on public.doc_revision
  for each row execute function app.doc_revision_guard();

alter table public.doc_document
  add constraint doc_document_working_revision_fk foreign key (working_revision_id, org_id)
    references public.doc_revision (id, org_id) on delete restrict;

-- ── the issued snapshot: written once, never updated ─────────────────────────
create table public.doc_snapshot (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  document_id uuid not null,
  revision_id uuid not null,
  -- Fully resolved: blocks with bindings resolved to literal values, issuer
  -- identity, branding (logo file id, accent), fonts, language, variables.
  snapshot jsonb not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null default now(),
  issued_by uuid not null references public.user_profile (id),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint doc_snapshot_id_org_uq unique (id, org_id),
  constraint doc_snapshot_document_uq unique (document_id),
  constraint doc_snapshot_document_fk foreign key (document_id, org_id)
    references public.doc_document (id, org_id) on delete restrict,
  constraint doc_snapshot_revision_fk foreign key (revision_id, org_id)
    references public.doc_revision (id, org_id) on delete restrict
);
alter table public.doc_snapshot enable row level security;
create policy doc_snapshot_select on public.doc_snapshot
  for select to app_user using (org_id = (select app.current_org_id()));
create policy doc_snapshot_insert on public.doc_snapshot
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
grant select, insert on public.doc_snapshot to app_user;
-- No UPDATE grant, and the trigger holds for every role.
create trigger doc_snapshot_immutable
  before update on public.doc_snapshot
  for each row execute function app.doc_reject_update();

alter table public.doc_document
  add constraint doc_document_issued_snapshot_fk foreign key (issued_snapshot_id, org_id)
    references public.doc_snapshot (id, org_id) on delete restrict;

-- ── the evidence timeline: append-only, hash-chained (ADR-21) ────────────────
create table public.doc_event (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  document_id uuid not null,
  seq integer not null check (seq >= 1),
  kind text not null check (kind ~ '^[a-z_]{1,40}$'),
  actor_user_id uuid references public.user_profile (id),
  -- External participants (signers, form submitters) have no user row.
  actor_label text check (actor_label is null or length(actor_label) <= 200),
  payload jsonb not null default '{}',
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  event_hash text not null check (event_hash ~ '^[0-9a-f]{64}$'),
  at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint doc_event_id_org_uq unique (id, org_id),
  constraint doc_event_seq_uq unique (document_id, seq),
  constraint doc_event_document_fk foreign key (document_id, org_id)
    references public.doc_document (id, org_id) on delete restrict
);
create index doc_event_org_doc_idx on public.doc_event (org_id, document_id, seq);
alter table public.doc_event enable row level security;
create policy doc_event_select on public.doc_event
  for select to app_user using (org_id = (select app.current_org_id()));
create policy doc_event_insert on public.doc_event
  for insert to app_user
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.doc_event to app_user;
create trigger doc_event_immutable
  before update on public.doc_event
  for each row execute function app.doc_reject_update();

-- ── anchored comments, suggestions and threads (ADR-31) ──────────────────────
create table public.doc_comment (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  document_id uuid not null,
  revision_id uuid,
  block_id text check (block_id is null or block_id ~ '^[A-Za-z0-9_-]{1,40}$'),
  parent_id uuid,
  body text not null check (length(trim(body)) between 1 and 4000),
  author_user_id uuid not null references public.user_profile (id),
  mentions uuid[] not null default '{}' check (cardinality(mentions) <= 20),
  -- A suggested change: { blockId, proposed } — applied only by an explicit accept.
  suggestion jsonb,
  suggestion_status text check (suggestion_status is null or suggestion_status in (
    'proposed', 'accepted', 'rejected'
  )),
  resolved_at timestamptz,
  resolved_by uuid references public.user_profile (id),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint doc_comment_id_org_uq unique (id, org_id),
  constraint doc_comment_document_fk foreign key (document_id, org_id)
    references public.doc_document (id, org_id) on delete restrict,
  constraint doc_comment_revision_fk foreign key (revision_id, org_id)
    references public.doc_revision (id, org_id) on delete restrict,
  constraint doc_comment_parent_fk foreign key (parent_id, org_id)
    references public.doc_comment (id, org_id) on delete restrict,
  constraint doc_comment_suggestion_ck
    check ((suggestion is null) = (suggestion_status is null))
);
create index doc_comment_org_doc_idx on public.doc_comment (org_id, document_id, created_at);
alter table public.doc_comment enable row level security;
create policy doc_comment_select on public.doc_comment
  for select to app_user using (org_id = (select app.current_org_id()));
create policy doc_comment_insert on public.doc_comment
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and author_user_id = (select app.current_user_id()));
create policy doc_comment_update on public.doc_comment
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.doc_comment to app_user;
grant update (suggestion_status, resolved_at, resolved_by, removed_at, updated_at)
  on public.doc_comment to app_user;

-- ── saved views of the document library ──────────────────────────────────────
create table public.doc_saved_view (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 120),
  config jsonb not null default '{}',
  is_shared boolean not null default false,
  created_by uuid not null references public.user_profile (id),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint doc_saved_view_id_org_uq unique (id, org_id)
);
create index doc_saved_view_org_idx on public.doc_saved_view (org_id, created_by) where removed_at is null;
alter table public.doc_saved_view enable row level security;
-- Private until shared: the owner sees theirs; everyone sees shared ones.
create policy doc_saved_view_select on public.doc_saved_view
  for select to app_user
  using (org_id = (select app.current_org_id())
         and (is_shared or created_by = (select app.current_user_id())));
create policy doc_saved_view_insert on public.doc_saved_view
  for insert to app_user
  with check (org_id = (select app.current_org_id())
              and created_by = (select app.current_user_id()));
create policy doc_saved_view_update on public.doc_saved_view
  for update to app_user
  using (org_id = (select app.current_org_id())
         and created_by = (select app.current_user_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.doc_saved_view to app_user;
grant update (name, config, is_shared, removed_at, updated_at) on public.doc_saved_view to app_user;

-- updated_at touch triggers (same helper every table uses)
create trigger doc_folder_touch before update on public.doc_folder
  for each row execute function app.set_updated_at();
create trigger doc_workflow_touch before update on public.doc_workflow
  for each row execute function app.set_updated_at();
create trigger doc_template_touch before update on public.doc_template
  for each row execute function app.set_updated_at();
create trigger doc_document_touch before update on public.doc_document
  for each row execute function app.set_updated_at();
create trigger doc_revision_touch before update on public.doc_revision
  for each row execute function app.set_updated_at();
create trigger doc_comment_touch before update on public.doc_comment
  for each row execute function app.set_updated_at();
create trigger doc_saved_view_touch before update on public.doc_saved_view
  for each row execute function app.set_updated_at();

comment on table public.doc_document is
  'H26: the authored document. Content lives in doc_revision (one working, the rest frozen); issuing writes one immutable doc_snapshot; doc_event is the hash-chained evidence timeline.';
comment on table public.doc_snapshot is
  'H26: the issued document exactly as issued. No UPDATE grant and a trigger that refuses updates for every role.';
