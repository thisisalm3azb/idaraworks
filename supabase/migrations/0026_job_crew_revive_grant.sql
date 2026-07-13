-- 0026_job_crew_revive_grant (S2 fix). addCrewMember revives a soft-removed
-- row via ON CONFLICT DO UPDATE, which also re-stamps added_by/added_at — both
-- outside 0025's (removed_at, removed_by) column grant, so revival failed with
-- 42501. Widen the UPDATE grant to the four assignment-lifecycle columns; the
-- identity columns (org_id, job_id, employee_id) stay immutable.
-- Rollback note: forward-only; grant-only, non-destructive.

grant update (added_by, added_at, removed_at, removed_by) on public.job_crew to app_user;
