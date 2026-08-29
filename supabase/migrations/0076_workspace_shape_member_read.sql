-- 0076_workspace_shape_member_read (H16 — adaptive workspace shell)
-- Every ACTIVE member's shell derives from the organization's APPLIED
-- blueprint revision, so members need read access to exactly that one row.
-- This policy grants SELECT on applied revisions to any active member of the
-- organization; drafts, validated/approved revisions, rejections and the
-- superseded history remain owner/admin-only through the 0075 policy.
-- Nothing here grants any write: INSERT/UPDATE stay owner/admin (0075), and
-- there is still no DELETE grant anywhere (D-1.7).
--
-- Rollback note: drop policy; safe (the shell falls back to legacy behavior
-- when it cannot read a shape — fail-safe by construction).

create policy workspace_blueprint_member_shape on public.workspace_blueprint_revision
  for select to app_user
  using (
    org_id = (select app.current_org_id())
    and status = 'applied'
    and exists (
      select 1 from public.membership m
      where m.org_id = workspace_blueprint_revision.org_id
        and m.user_id = (select app.current_user_id())
        and m.deactivated_at is null
    )
  );
