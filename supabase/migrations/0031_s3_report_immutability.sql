-- 0031_s3_report_immutability (S3 — the C-6 edit-window backstop AT THE DB).
-- The service is the single enforcement point (doc 10 #15), but report
-- immutability is an audit/heartbeat guarantee (D-1.5/D-1.7, C-6) and the user's
-- S3 rule requires authz "at BOTH service AND database levels where required".
-- Edit windows by status:
--   draft/returned  → AUTHOR edits header + all lines (add/update/delete)
--   submitted       → REVIEWER (A/M) reviews/returns + corrects MATERIAL lines
--   reviewed        → IMMUTABLE (nobody edits)
-- Forward-only: policy replacements only, no data change.

-- ── daily_report: author edits only while draft/returned ─────────────────────
drop policy daily_report_update on public.daily_report;
create policy daily_report_update on public.daily_report
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and submitted_by = (select app.current_user_id())
    and status in ('draft', 'returned')
  )
  with check (
    org_id = (select app.current_org_id())
    and submitted_by = (select app.current_user_id())
    and status in ('draft', 'returned', 'submitted')
  );
-- CHECK allows the resulting 'submitted' so the author's own draft→submitted
-- promotion passes; USING gates entry to draft/returned only (no touching a
-- submitted/reviewed report as the author).

-- ── daily_report: reviewer acts ONLY on a submitted report ───────────────────
-- USING pins the current row to 'submitted' (can't touch draft/reviewed/
-- returned); CHECK allows the resulting reviewed|returned (and submitted, for a
-- material-only correction that leaves status unchanged).
drop policy daily_report_review_update on public.daily_report;
create policy daily_report_review_update on public.daily_report
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin', 'manager')
    and status = 'submitted'
  )
  with check (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin', 'manager')
    and status in ('submitted', 'reviewed', 'returned')
  );

-- ── line UPDATE windows (parent status) ──────────────────────────────────────
-- Work + labour lines: author narrative/hours — editable only draft/returned.
-- Material lines: also editable while submitted (A/M "edit materials post-submit").
-- None editable once reviewed (C-6).
drop policy report_work_line_update on public.report_work_line;
create policy report_work_line_update on public.report_work_line
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and exists (
      select 1 from public.daily_report r
      where r.id = report_id and r.org_id = (select app.current_org_id())
        and r.status in ('draft', 'returned')
    )
  )
  with check (org_id = (select app.current_org_id()));

drop policy report_material_line_update on public.report_material_line;
create policy report_material_line_update on public.report_material_line
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and exists (
      select 1 from public.daily_report r
      where r.id = report_id and r.org_id = (select app.current_org_id())
        and r.status in ('draft', 'returned', 'submitted')
    )
  )
  with check (org_id = (select app.current_org_id()));

drop policy report_labour_line_update on public.report_labour_line;
create policy report_labour_line_update on public.report_labour_line
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and exists (
      select 1 from public.daily_report r
      where r.id = report_id and r.org_id = (select app.current_org_id())
        and r.status in ('draft', 'returned')
    )
  )
  with check (org_id = (select app.current_org_id()));
