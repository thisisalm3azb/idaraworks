-- 0027_s2_review_hardening (S2 independent-review fixes).
-- Rollback note: forward-only; grant tightening + additive constraints.

-- ── CM: restore the job_crew actor pin ───────────────────────────────────────
-- 0026 granted UPDATE on added_by/added_at so the revival upsert could re-stamp
-- them, but the update policy only checks org_id — so any member could rewrite
-- added_by (even to a cross-org user id). crew.ts no longer re-stamps them on
-- revival (only clears removed_at/removed_by), so the grant is unnecessary and
-- the pin is restored: added_by/added_at are now immutable after insert.
revoke update (added_by, added_at) on public.job_crew from app_user;

-- ── Defense-in-depth: cross-JOB / cross-ORG referential integrity ────────────
-- RLS blocks cross-ORG, and the services now validate cross-JOB in the command
-- transaction — these composite FKs make the invariants structural too (FK
-- checks bypass RLS, so a bug or raw path cannot smuggle a mismatched ref).

-- A task's stage must belong to the task's own job.
alter table public.job_stage add constraint job_stage_id_job_uq unique (id, job_id);
alter table public.task
  add constraint task_stage_job_fk foreign key (stage_id, job_id)
  references public.job_stage (id, job_id) on delete restrict;

-- The job's denormalised current stage must be one of its OWN stages.
alter table public.job
  add constraint job_current_stage_fk foreign key (current_stage_id, id)
  references public.job_stage (id, job_id) on delete restrict;

-- Cross-org pins: task's job/assignee and job_crew's job/employee share the org.
alter table public.job add constraint job_id_org_uq unique (id, org_id);
alter table public.task
  add constraint task_job_org_fk foreign key (job_id, org_id)
  references public.job (id, org_id) on delete restrict;
alter table public.task
  add constraint task_assignee_org_fk foreign key (assignee_employee_id, org_id)
  references public.employee (id, org_id) on delete restrict;
alter table public.job_crew
  add constraint job_crew_job_org_fk foreign key (job_id, org_id)
  references public.job (id, org_id) on delete restrict;
alter table public.job_crew
  add constraint job_crew_employee_org_fk foreign key (employee_id, org_id)
  references public.employee (id, org_id) on delete restrict;
