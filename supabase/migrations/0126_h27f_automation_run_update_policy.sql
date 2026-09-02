-- H27F — automation run rows are claimed on insert and finalised (applied /
-- failed) by the same sweep, which needs an UPDATE policy next to the
-- column-scoped grant in 0125. Additive only; no data change.

-- Run rows are claimed on insert and then finalised (applied / failed) by the
-- same sweep; that needs an UPDATE policy alongside the column grant above.
create policy crm_automation_run_update on public.crm_automation_run
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
