-- 0033_s3_line_insert_immutability (S3 review fix B — close the C-6 INSERT gap).
-- 0031 status-gated the line UPDATE policies and 0032 removed DELETE, but the
-- three line INSERT policies still gated ONLY on org — so app_user (NOBYPASSRLS)
-- could APPEND a live line onto a submitted/reviewed report, defeating the
-- audit-heartbeat immutability the S3 rule requires at BOTH service AND DB level.
-- Gate INSERT on the parent status too: lines are only ever inserted while the
-- report is draft/returned (the editable window; see reports/service.replaceLines),
-- so that is the tightest correct WITH CHECK. Forward-only: policy replacements.

drop policy report_work_line_insert on public.report_work_line;
create policy report_work_line_insert on public.report_work_line
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and exists (
      select 1 from public.daily_report r
      where r.id = report_id and r.org_id = (select app.current_org_id())
        and r.status in ('draft', 'returned')
    )
  );

drop policy report_material_line_insert on public.report_material_line;
create policy report_material_line_insert on public.report_material_line
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and exists (
      select 1 from public.daily_report r
      where r.id = report_id and r.org_id = (select app.current_org_id())
        and r.status in ('draft', 'returned')
    )
  );

drop policy report_labour_line_insert on public.report_labour_line;
create policy report_labour_line_insert on public.report_labour_line
  for insert to app_user
  with check (
    org_id = (select app.current_org_id())
    and exists (
      select 1 from public.daily_report r
      where r.id = report_id and r.org_id = (select app.current_org_id())
        and r.status in ('draft', 'returned')
    )
  );
