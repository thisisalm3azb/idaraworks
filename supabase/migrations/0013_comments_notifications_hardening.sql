-- 0013_comments_notifications_hardening
-- Phase F review hardening (0011 already hosted-applied → forward-only).
--   m4 (defense-in-depth): comment_update was org-only, so the column grant let
--      ANY org member rewrite/soft-delete ANOTHER member's comment via a stray
--      query. The author-only invariant lived solely in app code. Add the DB
--      backstop: only the author may edit/soft-delete their own comment.
--   m3 (defense-in-depth): notification_insert accepted any user_id; a bug could
--      spray notifications to arbitrary ids. Require the recipient to be an
--      ACTIVE member of the org.
-- Rollback note: forward-only; re-create the 0011 forms. Non-destructive.

-- ── comment_update: author-only (matches softDeleteComment's app rule) ───────
drop policy comment_update on public.comment;
create policy comment_update on public.comment
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and author_user_id = (select app.current_user_id())
  )
  with check (
    org_id = (select app.current_org_id())
    and author_user_id = (select app.current_user_id())
  );

-- ── notification_insert: recipient must be an active member of the org ───────
drop policy notification_insert on public.notification;
create policy notification_insert on public.notification
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and user_id in (
      select m.user_id from public.membership m
      where m.org_id = (select app.current_org_id()) and m.deactivated_at is null
    )
  );
