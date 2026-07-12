-- 0009_files_hardening
-- Phase E independent-review hardening (0008 already hosted-applied → forward-only).
-- Closes the confirmed-material + material-minor findings:
--   CM2/CM4  direct-upload quota bypass — storage INSERT now requires a matching
--            pending file row (one quota-checked mint = one object).
--   m8       BLOCKING: `authenticated` lacked USAGE on schema app → every signed
--            URL mint would have failed. Granted.
--   m9       membership oracle — can_access_file_class is no longer authenticated-
--            facing; a new wrapper binds the identity to auth.uid().
--   m18      uuid cast could raise 22P02 mid-policy and error all storage reads —
--            the wrapper regex-guards before casting.
--   m14      legal_hold / void had no DB backstop (column grant, org-only RLS) —
--            moved behind org+identity-pinned SECURITY DEFINER functions; columns
--            dropped from the app_user grant.
--   m10/m12  void double-subtract under concurrency — the definer FOR UPDATEs and
--            is authoritative on its own row count.
--   m7/m17   quota TOCTOU — reservation on sign (reserved_bytes) + opportunistic
--            self-sweep releases it; accounting is reserve→settle.
--   m13      reconcile lock-ordering race — sum computed under the counter lock.
-- Rollback note: forward-only; re-create the 0008 forms. Non-destructive.

-- ── reservation column (m7) ──────────────────────────────────────────────────
-- Declared byte reservation held while a file is pending; settled to actual
-- bytes when the worker completes, released when it fails/voids.
alter table public.file add column reserved_bytes bigint not null default 0
  check (reserved_bytes >= 0);

-- ── m9: can_access_file_class is app_user-internal only ──────────────────────
-- (used by the file-table policies, where app_user already passes a trusted,
--  ctx-derived p_user). Revoke the authenticated grant that made it an oracle.
revoke execute on function app.can_access_file_class(uuid, uuid, text, boolean) from authenticated;

-- ── m8: authenticated needs schema usage to call the wrapper below ───────────
grant usage on schema app to authenticated;

-- ── storage-object access wrapper (authenticated-facing) ─────────────────────
-- The ONLY app.* function the end-user role may call. Binds the subject to
-- auth.uid() (no oracle), regex-guards the org extraction before casting (m18),
-- and for writes requires a matching quota-checked pending file row (CM2/CM4).
create or replace function app.can_access_storage_object(
  p_bucket text,
  p_name text,
  p_write boolean
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_folder text[] := storage.foldername(p_name);
  v_org text;
  v_class text;
  v_bucket_ok boolean;
begin
  if v_uid is null then return false; end if;
  if array_length(v_folder, 1) is null or array_length(v_folder, 1) < 2 then
    return false;
  end if;
  v_org := v_folder[1];
  v_class := v_folder[2];
  -- Regex-guard BEFORE the uuid cast so a malformed object name can never raise
  -- 22P02 inside policy evaluation (which would error every storage query).
  if v_org !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  -- class ↔ bucket consistency (a financial doc cannot hide in tenant-media).
  v_bucket_ok := (v_class in ('job_media', 'customer_share') and p_bucket = 'tenant-media')
    or (v_class in ('financial_doc', 'hr_doc') and p_bucket = 'tenant-docs');
  if not v_bucket_ok then return false; end if;

  if not app.can_access_file_class(v_org::uuid, v_uid, v_class, p_write) then
    return false;
  end if;

  if p_write then
    -- Every object write must correspond to a quota-checked pending mint by the
    -- same user at exactly this path (closes the direct-upload bypass, CM2/CM4).
    return exists (
      select 1 from public.file
      where object_path = p_name and status = 'pending' and created_by = v_uid
    );
  end if;
  return true;
end
$$;
revoke all on function app.can_access_storage_object(text, text, boolean) from public;
grant execute on function app.can_access_storage_object(text, text, boolean) to authenticated;

-- ── recreate the storage.objects policies against the wrapper ────────────────
drop policy tenant_objects_insert on storage.objects;
drop policy tenant_objects_select on storage.objects;

create policy tenant_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('tenant-media', 'tenant-docs')
    and app.can_access_storage_object(bucket_id, name, true)
  );
create policy tenant_objects_select on storage.objects
  for select to authenticated
  using (
    bucket_id in ('tenant-media', 'tenant-docs')
    and app.can_access_storage_object(bucket_id, name, false)
  );

-- ── m14 + m10/m12: void / legal-hold behind identity-pinned definer fns ──────
-- The columns leave the app_user grant; only these functions (org+actor pinned,
-- FOR UPDATE, authoritative) may mutate them. Archetype authz stays in the app
-- (assertCan) as the first wall; this is the DB backstop.
create or replace function app.void_file(p_file uuid, p_reason text)
returns table (original_name text, prev_status text, effective_bytes bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select app.current_org_id());
  v_actor uuid := (select app.current_user_id());
  v_row record;
  v_eff bigint;
begin
  if v_org is null or v_actor is null then
    raise exception 'void requires an org/user context';
  end if;
  select * into v_row from public.file
    where id = p_file and org_id = v_org for update;
  if not found then raise exception 'file not found' using errcode = 'no_data_found'; end if;
  if v_row.voided_at is not null then
    raise exception 'file already voided' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_row.legal_hold then
    raise exception 'file under legal hold' using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.file
    set voided_at = now(), voided_by = v_actor, void_reason = p_reason, reserved_bytes = 0
    where id = p_file and org_id = v_org and voided_at is null;
  if not found then
    raise exception 'file already voided' using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Effective bytes leaving the quota: actual for ready, reservation for pending.
  v_eff := case when v_row.status = 'ready' then coalesce(v_row.bytes, 0)
                else coalesce(v_row.reserved_bytes, 0) end;
  if v_eff > 0 then
    update public.org_storage_usage
      set bytes_used = greatest(0, bytes_used - v_eff) where org_id = v_org;
  end if;

  original_name := v_row.original_name;
  prev_status := v_row.status;
  effective_bytes := v_eff;
  return next;
end
$$;
revoke all on function app.void_file(uuid, text) from public;
grant execute on function app.void_file(uuid, text) to app_user;

create or replace function app.set_legal_hold(p_file uuid, p_hold boolean)
returns table (original_name text, was_held boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select app.current_org_id());
  v_row record;
begin
  if v_org is null then raise exception 'legal hold requires an org context'; end if;
  select * into v_row from public.file where id = p_file and org_id = v_org for update;
  if not found then raise exception 'file not found' using errcode = 'no_data_found'; end if;
  update public.file set legal_hold = p_hold where id = p_file and org_id = v_org;
  original_name := v_row.original_name;
  was_held := v_row.legal_hold;
  return next;
end
$$;
revoke all on function app.set_legal_hold(uuid, boolean) from public;
grant execute on function app.set_legal_hold(uuid, boolean) to app_user;

-- Drop the sensitive columns from the app_user grant (m14). The worker keeps
-- status/bytes/variants/exif_stripped/reserved_bytes; void/legal-hold go through
-- the definers above.
revoke update on public.file from app_user;
grant update (status, bytes, mime, variants, exif_stripped, reserved_bytes)
  on public.file to app_user;

-- ── m7: reservation-aware stale sweep (releases reservations) ────────────────
create or replace function app.fail_stale_pending_files(p_org uuid, p_max_age interval)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released bigint;
  v_count int;
begin
  if p_org is distinct from (select app.current_org_id()) then
    raise exception 'org mismatch: stale sweep must run in the org''s context';
  end if;
  with swept as (
    update public.file
      set status = 'failed', reserved_bytes = 0
      where org_id = p_org and status = 'pending' and voided_at is null
        and created_at < now() - p_max_age
      returning reserved_bytes
  )
  select coalesce(sum(reserved_bytes), 0), count(*) into v_released, v_count from swept;
  if v_released > 0 then
    update public.org_storage_usage
      set bytes_used = greatest(0, bytes_used - v_released) where org_id = p_org;
  end if;
  return v_count;
end
$$;
revoke all on function app.fail_stale_pending_files(uuid, interval) from public;
grant execute on function app.fail_stale_pending_files(uuid, interval) to app_user;

-- ── m13: reconcile computes the sum UNDER the counter lock (no race) ─────────
-- Effective bytes = ready→actual + pending→reservation. Locks/creates the
-- counter row first, then sums, then sets — a concurrent flip is either counted
-- (committed before the sum) or picked up next run, never torn.
-- (Return type changes bigint→table vs 0008, so DROP before recreate.)
drop function if exists app.reconcile_storage_usage(uuid, bigint);
create or replace function app.reconcile_storage_usage(p_org uuid, p_bytes bigint default null)
returns table (previous_bytes bigint, current_bytes bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev bigint;
  v_sum bigint;
begin
  if p_org is distinct from (select app.current_org_id()) then
    raise exception 'org mismatch: reconcile must run in the org''s context';
  end if;
  -- Ensure the counter row exists, then lock it before reading file truth.
  insert into public.org_storage_usage (org_id, bytes_used) values (p_org, 0)
    on conflict (org_id) do nothing;
  select bytes_used into v_prev from public.org_storage_usage where org_id = p_org for update;
  select coalesce(sum(case when status = 'ready' then coalesce(bytes, 0)
                           when status = 'pending' then coalesce(reserved_bytes, 0)
                           else 0 end), 0)
    into v_sum from public.file where org_id = p_org and voided_at is null;
  update public.org_storage_usage
    set bytes_used = v_sum, reconciled_at = now() where org_id = p_org;
  previous_bytes := coalesce(v_prev, 0);
  current_bytes := v_sum;
  return next;
end
$$;
revoke all on function app.reconcile_storage_usage(uuid, bigint) from public;
grant execute on function app.reconcile_storage_usage(uuid, bigint) to app_user;

-- Effective per-org byte truth (ready + pending reservation), org-pinned.
create or replace function app.org_file_bytes(p_org uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_org is distinct from (select app.current_org_id()) then null
    else (
      select coalesce(sum(case when status = 'ready' then coalesce(bytes, 0)
                               when status = 'pending' then coalesce(reserved_bytes, 0)
                               else 0 end), 0)
      from public.file where org_id = p_org and voided_at is null
    )
  end
$$;
revoke all on function app.org_file_bytes(uuid) from public;
grant execute on function app.org_file_bytes(uuid) to app_user;

-- ── CM4 leak detector: the set of object paths the DB knows about ────────────
-- reconcile diffs the bucket listing against this; keys with no owning row are
-- orphans (leaked/abandoned) and get an error-level alarm.
create or replace function app.org_known_object_paths(p_org uuid)
returns setof text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_org is distinct from (select app.current_org_id()) then
    return; -- wrong context: no cross-org enumeration
  end if;
  return query
    select f.object_path from public.file f
      where f.org_id = p_org and f.voided_at is null and f.status <> 'failed'
    union
    select v.value ->> 'path'
      from public.file f, jsonb_each(coalesce(f.variants, '{}'::jsonb)) as v
      where f.org_id = p_org and f.voided_at is null and f.status = 'ready'
        and v.value ? 'path';
end
$$;
revoke all on function app.org_known_object_paths(uuid) from public;
grant execute on function app.org_known_object_paths(uuid) to app_user;
