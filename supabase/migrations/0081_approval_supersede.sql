-- 0081_approval_supersede (H21.1 - an approval whose subject died stops waiting)
--
-- H21 left a gap: cancelling a task that was awaiting approval left its approval
-- row pending forever. It failed safe, because decideApproval guards the subject
-- UPDATE on `status = live` so a late decision moved nothing, but the approval
-- sat in the inbox asking a question about work that no longer exists, and the
-- decision history then recorded an approval for a cancelled task.
--
-- 'superseded' has been a legal approval state since 0034; nothing ever wrote it.
-- The state value was allowed by the CHECK constraint but no RLS policy permitted
-- the transition, so the value was unreachable from application code. Both UPDATE
-- policies pin their result: approval_decide_update requires the new state to be
-- approved/rejected, approval_withdraw_update requires withdrawn. This adds the
-- third, equally tight transition.
--
-- Why a separate policy rather than widening approval_decide_update: deciding and
-- superseding are different acts by different people for different reasons. A
-- decision answers the question; a supersession withdraws the question because its
-- subject is gone. Keeping them apart means neither can be used to reach the other's
-- state, and the WITH CHECK on each stays a single exact value.
--
-- The archetypes match who can actually close a task: tasks.manage is owner, admin
-- and manager (src/platform/authz/matrix.ts). The service layer asserts the precise
-- permission, as it does for deciding; this is the backstop.
--
-- No new column and no new grant: state, decided_by, decided_at and decision_note
-- are already granted to app_user, and approval_decided_ck already forces a
-- superseding write to name who caused it.

create policy approval_supersede_update on public.approval
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin', 'manager')
    and state = 'pending'
  )
  with check (
    org_id = (select app.current_org_id())
    and state = 'superseded'
    and decided_by is not null
  );

-- No new index: approval_one_live_per_subject (0037) is already a unique index on
-- (org_id, subject_type, subject_id) where state = 'pending', which is exactly the
-- lookup the supersede path performs.
--
-- That index is also why superseding is the right move rather than a workaround:
-- it constrains only PENDING rows, so once an approval is superseded the subject is
-- free to open a fresh one. A restored step re-submitted for completion gets a new
-- approval; the old one stays superseded and never silently comes back to life.
