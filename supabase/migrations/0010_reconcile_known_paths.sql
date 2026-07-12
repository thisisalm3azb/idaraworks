-- 0010_reconcile_known_paths
-- Fix (Phase E review CM4 detector semantics): org_known_object_paths must count
-- an object as KNOWN if ANY file row references it — regardless of status or
-- void. Voided-but-unpurged objects and failed-upload originals are EXPECTED
-- residue awaiting the later-slice purge pipelines (doc 10 #40), not leaks. Only
-- an object with NO owning row at all is a true orphan (a bypassed direct upload).
-- The 0009 form excluded voided/failed rows, so a voided file's objects were
-- mis-flagged as orphans and reconcile drift never cleared.
-- Rollback note: forward-only; re-create the 0009 form. Non-destructive.

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
    select f.object_path from public.file f where f.org_id = p_org
    union
    select v.value ->> 'path'
      from public.file f, jsonb_each(coalesce(f.variants, '{}'::jsonb)) as v
      where f.org_id = p_org and v.value ? 'path';
end
$$;
revoke all on function app.org_known_object_paths(uuid) from public;
grant execute on function app.org_known_object_paths(uuid) to app_user;
