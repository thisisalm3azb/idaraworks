-- 0023_s1_hardening (S1 independent-review fixes — confirmed material + minors).
-- Rollback note: forward-only; policy/constraint replacements, non-destructive.

-- ── CM1: the cost/price walls' CONTROL FLAG gets its DB backstop ─────────────
-- 0021's role_definition_update policy checked only the org, so ANY tenant
-- session could flip cost_privileged/price_privileged — the flag that FEEDS the
-- employee_terms GUC wall. Same discipline as employee_hr (0020): writes pinned
-- to owner/admin AT THE DATABASE, not just at the app's config.manage gate.
drop policy role_definition_update on public.role_definition;
create policy role_definition_update on public.role_definition
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin')
  )
  with check (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin')
  );

-- ── minor: org-consistency binding for the privileged side-tables ────────────
-- employee_terms/employee_hr carried their own org_id and an employee FK, but
-- nothing bound the two — a (bugged) writer could attach org A's salary row to
-- org B's employee. Composite FK pins (employee_id, org_id) together.
alter table public.employee add constraint employee_id_org_uq unique (id, org_id);
alter table public.employee_terms
  add constraint employee_terms_org_fk foreign key (employee_id, org_id)
  references public.employee (id, org_id) on delete restrict;
alter table public.employee_hr
  add constraint employee_hr_org_fk foreign key (employee_id, org_id)
  references public.employee (id, org_id) on delete restrict;

-- ── minor: daily_report updates are AUTHOR-pinned (S1) ───────────────────────
-- The insert policy pinned the author; the update policy did not — any member
-- could rewrite a colleague's report. S1 scope: author-only edits; the S3
-- review flow (manager edit-materials-post-submit) arrives with its slice and
-- will widen this deliberately.
drop policy daily_report_update on public.daily_report;
create policy daily_report_update on public.daily_report
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and submitted_by = (select app.current_user_id())
  )
  with check (
    org_id = (select app.current_org_id())
    and submitted_by = (select app.current_user_id())
  );

-- ── minor: job inserts pin the creator (parity with daily_report) ────────────
drop policy job_insert on public.job;
create policy job_insert on public.job
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and created_by = (select app.current_user_id())
  );
