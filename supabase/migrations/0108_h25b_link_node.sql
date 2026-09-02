-- 0108_h25b_link_node (H25 — the ONE way a draft node becomes a linked node).
--
-- record_type/record_id are deliberately outside app_user's UPDATE grant on
-- studio_node (0107): a link is identity, and re-pointing one would let a
-- node silently start reading a different record's dates and money. The
-- draft → linked transition (convertNode) therefore goes through this
-- SECURITY DEFINER function, which allows exactly one direction — from no
-- link to a link — inside the caller's organization. Nothing here validates
-- the target record: the service creates it through the owning module first
-- (createTask / createIssue) and passes the id it was handed back.

create or replace function app.link_studio_node(
  p_node uuid,
  p_record_type text,
  p_record_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
  v_user uuid;
  n record;
begin
  select app.current_org_id() into v_org;
  select app.current_user_id() into v_user;
  if v_org is null or v_user is null then
    raise exception 'linking a node requires an organization context';
  end if;
  if p_record_type is null or p_record_id is null then
    raise exception 'a link needs both a record type and a record id';
  end if;

  select id, record_type, archived_at into n
  from public.studio_node
  where id = p_node and org_id = v_org
  for update;
  if n.id is null then
    raise exception 'node not found';
  end if;
  if n.archived_at is not null then
    raise exception 'node is archived';
  end if;
  if n.record_type is not null then
    raise exception 'node is already linked; a link is never re-pointed';
  end if;

  update public.studio_node set
    record_type = p_record_type,
    record_id = p_record_id,
    row_version = row_version + 1,
    updated_by = v_user,
    updated_at = now()
  where id = p_node and org_id = v_org;
end;
$$;
revoke all on function app.link_studio_node(uuid, text, uuid) from public;
grant execute on function app.link_studio_node(uuid, text, uuid) to app_user;
