-- 0008_files_storage (S0 checklist §3 "files_storage", renumbered; doc 01
-- Appendix A; BUILD_BIBLE §7; doc 10 #7, #38-41).
-- file metadata + org storage usage + the class-map DB wall:
--   * public.file — org-scoped, access-class typed, polymorphic attach target,
--     void/legal-hold foundations (D-1.7: no DELETE grant, void is an UPDATE).
--   * public.org_storage_usage — transactional per-org byte counter.
--   * app.can_access_file_class — ONE definer function holding the class map's
--     DB mirror, shared by the file-table policies (GUC context) and the
--     storage.objects policies (authenticated/JWT context). One rule, one place.
--   * storage.objects RLS — the DB-level second wall for signed upload/read:
--     the app signs URLs AS THE USER (anon key + session), so Postgres enforces
--     org membership + class even if the app-layer check is bypassed.
-- Buckets are NOT created here (checklist §3: buckets via config, not SQL) —
-- config.toml declares them locally; tooling/scripts/setup-storage.ts on hosted.
-- Rollback note: drop policies on storage.objects, drop tables + function;
-- objects in buckets are unaffected (restore-from-backup for data).

-- ── file ──────────────────────────────────────────────────────────────────────
create table public.file (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  access_class text not null check (
    access_class in ('job_media', 'financial_doc', 'hr_doc', 'customer_share')
  ),
  -- Polymorphic attachment (registry-typed in app: ATTACHABLE_TYPES). No FK by
  -- design — target tables land in later slices; the owning module validates.
  attached_to_type text not null,
  attached_to_id uuid not null,
  bucket text not null check (bucket in ('tenant-media', 'tenant-docs')),
  object_path text not null unique, -- org_id/<class>/<entity_type>/<entity_id>/<file_id>...
  original_name text not null,
  mime text not null,
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  bytes bigint check (bytes is null or bytes >= 0), -- TOTAL accounted bytes (main + variants [+ retained original]); null until ready
  variants jsonb, -- { main: {path,bytes,width,height,mime}, thumb: {...}, medium: {...}, original?: {...} }
  exif_stripped boolean not null default false,
  legal_hold boolean not null default false, -- suspends every deletion path (doc 10 #41)
  voided_at timestamptz, -- D-1.7: void, never delete
  voided_by uuid references public.user_profile (id),
  void_reason text,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index file_org_attached_idx on public.file (org_id, attached_to_type, attached_to_id, created_at);
create index file_org_created_idx on public.file (org_id, created_at);
-- Reconcile sweep: stale pendings are the hot filter.
create index file_org_pending_idx on public.file (org_id, created_at) where status = 'pending';

create trigger file_touch_updated_at
  before update on public.file
  for each row execute function app.set_updated_at();

-- ── the class map's DB mirror ─────────────────────────────────────────────────
-- Mirrors src/platform/authz/matrix.ts file actions (doc 06; parity asserted by
-- an integration test). SECURITY DEFINER so the authenticated role can consult
-- membership/role_definition WITHOUT holding any table grant on them (built-in
-- role grants were revoked in 0002 and stay revoked).
-- p_write=true → upload gate; p_write=false → read gate.
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
        -- Photos add: O/A/M + Foreman (assigned-condition enforced at the job
        -- surface, S1+). Read: every job-visibility role = all active members.
        when 'job_media' then
          (not p_write) or r.archetype in ('owner', 'admin', 'manager', 'foreman')
        -- Upload: the expense/PO creators. Read: finance.viewPrices flag.
        when 'financial_doc' then
          case when p_write
            then r.archetype in ('owner', 'admin', 'manager', 'procurement', 'accounts')
            else r.price_privileged
          end
        when 'hr_doc' then r.archetype in ('owner', 'admin')
        -- customer_share: minted by the S5 share surface only — no member path.
        else false
      end
  )
$$;
revoke all on function app.can_access_file_class(uuid, uuid, text, boolean) from public;
grant execute on function app.can_access_file_class(uuid, uuid, text, boolean) to app_user, authenticated;

-- ── file RLS (app_user, GUC context) ─────────────────────────────────────────
alter table public.file enable row level security;

-- Metadata reads are class-gated too (F-23: redaction at EVERY boundary —
-- original_name of a financial doc is itself sensitive). The creator always
-- sees their OWN file's metadata: a manager who attached a receipt can track
-- it (and the ingest worker, acting as the uploader, can process it) — object
-- CONTENT stays behind the class-gated signRead + storage RLS walls.
create policy file_select on public.file
  for select to app_user
  using (
    org_id = (select app.current_org_id())
    and (
      created_by = (select app.current_user_id())
      or app.can_access_file_class(
        org_id, (select app.current_user_id()), access_class, false
      )
    )
  );
create policy file_insert on public.file
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and created_by = (select app.current_user_id())
    and app.can_access_file_class(
      org_id, (select app.current_user_id()), access_class, true
    )
  );
-- Updates: status flips (worker), void, legal hold. Immutable identity columns
-- are protected by the COLUMN grant below, not by policy.
create policy file_update on public.file
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));

grant select, insert on public.file to app_user;
grant update (status, bytes, mime, variants, exif_stripped, legal_hold, voided_at, voided_by, void_reason)
  on public.file to app_user;
-- No DELETE grant — D-1.7 (and doc 10 #41: deletion pipelines are later slices).

-- ── org_storage_usage ─────────────────────────────────────────────────────────
create table public.org_storage_usage (
  org_id uuid primary key references public.org (id) on delete restrict,
  bytes_used bigint not null default 0 check (bytes_used >= 0),
  reconciled_at timestamptz,
  updated_at timestamptz not null default now()
);
create trigger org_storage_usage_touch_updated_at
  before update on public.org_storage_usage
  for each row execute function app.set_updated_at();

alter table public.org_storage_usage enable row level security;
create policy org_storage_usage_select on public.org_storage_usage
  for select to app_user
  using (org_id = (select app.current_org_id()));
create policy org_storage_usage_insert on public.org_storage_usage
  for insert to app_user
  with check (org_id = (select app.current_org_id()));
create policy org_storage_usage_update on public.org_storage_usage
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.org_storage_usage to app_user;
grant update (bytes_used, reconciled_at) on public.org_storage_usage to app_user;

-- ── reconcile helpers (worker runs without a membership; definer bypasses the
--    class-gated file policy for org-pinned AGGREGATES only) ──────────────────
-- Both pin p_org to the transaction's org GUC: a session can only ever touch
-- the org it is scoped to.
create or replace function app.reconcile_storage_usage(p_org uuid, p_bytes bigint)
returns bigint -- previous counter value (drift = previous <> p_bytes)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev bigint;
begin
  if p_org is distinct from (select app.current_org_id()) then
    raise exception 'org mismatch: reconcile must run in the org''s context';
  end if;
  if p_bytes is null or p_bytes < 0 then
    raise exception 'invalid byte count';
  end if;
  select bytes_used into v_prev from public.org_storage_usage where org_id = p_org for update;
  insert into public.org_storage_usage (org_id, bytes_used, reconciled_at)
  values (p_org, p_bytes, now())
  on conflict (org_id) do update set bytes_used = excluded.bytes_used, reconciled_at = now();
  return coalesce(v_prev, 0);
end
$$;
revoke all on function app.reconcile_storage_usage(uuid, bigint) from public;
grant execute on function app.reconcile_storage_usage(uuid, bigint) to app_user;

create or replace function app.org_file_bytes(p_org uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_org is distinct from (select app.current_org_id())
      then null -- wrong context: no cross-org aggregates, not even sums
    else (
      select coalesce(sum(bytes), 0) from public.file
      where org_id = p_org and status = 'ready' and voided_at is null
    )
  end
$$;
revoke all on function app.org_file_bytes(uuid) from public;
grant execute on function app.org_file_bytes(uuid) to app_user;

create or replace function app.fail_stale_pending_files(p_org uuid, p_max_age interval)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  if p_org is distinct from (select app.current_org_id()) then
    raise exception 'org mismatch: stale sweep must run in the org''s context';
  end if;
  update public.file
  set status = 'failed'
  where org_id = p_org and status = 'pending' and voided_at is null
    and created_at < now() - p_max_age;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;
revoke all on function app.fail_stale_pending_files(uuid, interval) from public;
grant execute on function app.fail_stale_pending_files(uuid, interval) to app_user;

-- ── storage.objects RLS — the DB wall behind signed URLs ─────────────────────
-- Signed upload/read URLs are minted server-side AS THE REQUESTING USER (anon
-- key + session JWT), so these policies are what actually authorizes the mint:
-- org membership + class rule, keyed on the object path convention
--   <org_id>/<class>/<entity_type>/<entity_id>/<file_id>[.variant].ext
-- No UPDATE/DELETE policy for authenticated: users can never mutate or remove
-- objects; the derivative worker uses the storage-scoped S3 credential, which
-- bypasses RLS by design (platform task, BUILD_BIBLE §5.2).
create policy tenant_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('tenant-media', 'tenant-docs')
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    -- class ↔ bucket consistency (a financial doc cannot hide in tenant-media)
    and bucket_id = case
      when (storage.foldername(name))[2] in ('job_media', 'customer_share') then 'tenant-media'
      when (storage.foldername(name))[2] in ('financial_doc', 'hr_doc') then 'tenant-docs'
      else '' -- unknown class: never matches a real bucket → denied
    end
    and app.can_access_file_class(
      ((storage.foldername(name))[1])::uuid,
      (select auth.uid()),
      (storage.foldername(name))[2],
      true
    )
  );

create policy tenant_objects_select on storage.objects
  for select to authenticated
  using (
    bucket_id in ('tenant-media', 'tenant-docs')
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and app.can_access_file_class(
      ((storage.foldername(name))[1])::uuid,
      (select auth.uid()),
      (storage.foldername(name))[2],
      false
    )
  );
