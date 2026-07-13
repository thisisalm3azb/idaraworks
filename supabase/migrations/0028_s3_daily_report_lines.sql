-- 0028_s3_daily_report_lines (S3 — "Report: the heartbeat", part 1 of 3).
-- The S1 daily_report header (0022) grows the review loop + line children.
-- Forward-only: ALTER + additive tables, no destructive drops of data columns.
-- doc 01 D-1.5 (report shape), D-1.4 (frozen snapshots live on labour — 0029),
-- doc 06 rows 44-45 (create own / review A-M), doc 10 #20 (idempotent submit).

-- ── daily_report: review loop + exactly-once key + backfill flag ─────────────
-- The status now walks draft → submitted → reviewed | returned (C-6: immutable
-- once reviewed; returned reopens the AUTHOR's edit). idempotency_key makes the
-- offline-outbox submit exactly-once (doc 10 #20 / BUILD_BIBLE §8.11).
alter table public.daily_report
  drop constraint if exists daily_report_status_check;
alter table public.daily_report
  add constraint daily_report_status_check
  check (status in ('draft', 'submitted', 'reviewed', 'returned'));

alter table public.daily_report
  add column if not exists reviewed_by uuid references public.user_profile (id),
  add column if not exists reviewed_at timestamptz,
  add column if not exists returned_by uuid references public.user_profile (id),
  add column if not exists returned_at timestamptz,
  add column if not exists return_reason text
    check (return_reason is null or length(return_reason) <= 2000),
  add column if not exists idempotency_key text
    check (idempotency_key is null or length(idempotency_key) between 8 and 128),
  add column if not exists is_backfill boolean not null default false;

-- Exactly-once: one report per (org, client key). A resubmit with the same key
-- (an offline retry) collides here and the service resolves it to the existing
-- report id rather than inserting twice.
create unique index if not exists daily_report_idem_uq
  on public.daily_report (org_id, idempotency_key)
  where idempotency_key is not null;

-- Review-queue read path (doc 06 row 45: A/M see submitted reports to review).
create index if not exists daily_report_status_idx
  on public.daily_report (org_id, status, report_date);

-- Composite unique so the line children pin (report_id, org_id) together — a
-- bugged writer cannot attach org A's line to org B's report (the S2 lesson).
alter table public.daily_report
  add constraint daily_report_id_org_uq unique (id, org_id);

-- The author still owns draft/returned edits (0023 policy stands). Add a SECOND
-- permissive UPDATE policy for the reviewers (A/M/owner) — post-submit review &
-- material correction (doc 06 row 45). Permissive policies are OR'd: the author
-- path and the reviewer path each satisfy USING+CHECK independently.
create policy daily_report_review_update on public.daily_report
  for update to app_user
  using (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin', 'manager')
  )
  with check (
    org_id = (select app.current_org_id())
    and (select app.current_archetype()) in ('owner', 'admin', 'manager')
  );

-- Widen the column grant for the review columns + the new header fields. The
-- author still can only touch summary/blockers/next_steps/status via the author
-- policy; the reviewer columns are reachable only under the reviewer policy.
grant update (
  summary, blockers, next_steps, status, submitted_at, updated_at,
  reviewed_by, reviewed_at, returned_by, returned_at, return_reason
) on public.daily_report to app_user;
-- idempotency_key / is_backfill are set at INSERT only (immutable identity) — no
-- UPDATE grant, so a retry cannot re-key an existing report.

-- ── report_work_line (progress narrative per stage, C-5 snapshot ref) ────────
create table public.report_work_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  report_id uuid not null references public.daily_report (id) on delete restrict,
  -- Stage is a SNAPSHOT ref: the key is the stable identity (D-9.2), the id is
  -- the job_stage row it described (nullable — a note need not target a stage).
  stage_key text check (stage_key is null or stage_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  stage_id uuid references public.job_stage (id),
  description text not null check (length(description) between 1 and 2000),
  -- Optional "we're ~% here" note — display only, NEVER the derived progress
  -- (U7: progress stays derived-not-stored; this is a human annotation).
  progress_note text check (progress_note is null or length(progress_note) <= 200),
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
create index report_work_line_report_idx on public.report_work_line (org_id, report_id, sort);
alter table public.report_work_line
  add constraint report_work_line_report_org_fk foreign key (report_id, org_id)
  references public.daily_report (id, org_id) on delete restrict;
alter table public.report_work_line enable row level security;
create policy report_work_line_select on public.report_work_line
  for select to app_user using (org_id = (select app.current_org_id()));
create policy report_work_line_insert on public.report_work_line
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy report_work_line_update on public.report_work_line
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
create policy report_work_line_delete on public.report_work_line
  for delete to app_user
  using (
    org_id = (select app.current_org_id())
    and exists (
      select 1 from public.daily_report r
      where r.id = report_id and r.org_id = (select app.current_org_id())
        and r.status in ('draft', 'returned')
    )
  );
grant select, insert, delete on public.report_work_line to app_user;
grant update (stage_key, stage_id, description, progress_note, sort)
  on public.report_work_line to app_user;
-- Lines are children of the audit heartbeat. DELETE is gated by the PARENT
-- status: only while the report is draft/returned (the author's editable
-- window) may the service replace lines. Once submitted/reviewed the lines are
-- frozen at the database, not just the service (C-6).

-- ── report_material_line (item-linked OR free-text; cost capture only) ───────
-- P3 rule: cost_only defaults TRUE and deducted_from_inventory stays FALSE in
-- S3 — reports NEVER depend on inventory being live (D-1.4). The stock slice
-- flips these later without a migration.
create table public.report_material_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  report_id uuid not null references public.daily_report (id) on delete restrict,
  item_id uuid references public.item (id),
  -- Free-text snapshot (D-1.6): the name as written, so a later item rename or a
  -- never-cataloged material still reads correctly on the historical report.
  item_name text not null check (length(item_name) between 1 and 160),
  qty numeric(14, 3) not null check (qty > 0),
  unit text not null check (length(unit) between 1 and 16),
  -- Unit cost is a FROZEN snapshot when sourced from catalog; NULL when unknown.
  unit_cost_minor bigint check (unit_cost_minor is null or unit_cost_minor >= 0),
  cost_source text not null default 'none'
    check (cost_source in ('catalog', 'manual', 'none')),
  cost_only boolean not null default true,
  deducted_from_inventory boolean not null default false,
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
create index report_material_line_report_idx on public.report_material_line (org_id, report_id, sort);
alter table public.report_material_line
  add constraint report_material_line_report_org_fk foreign key (report_id, org_id)
  references public.daily_report (id, org_id) on delete restrict;
-- item, when present, must be same-org (composite FK against item's org pin).
alter table public.item add constraint item_id_org_uq unique (id, org_id);
alter table public.report_material_line
  add constraint report_material_line_item_org_fk foreign key (item_id, org_id)
  references public.item (id, org_id) on delete restrict;
alter table public.report_material_line enable row level security;
create policy report_material_line_select on public.report_material_line
  for select to app_user using (org_id = (select app.current_org_id()));
create policy report_material_line_insert on public.report_material_line
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy report_material_line_update on public.report_material_line
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
create policy report_material_line_delete on public.report_material_line
  for delete to app_user
  using (
    org_id = (select app.current_org_id())
    and exists (
      select 1 from public.daily_report r
      where r.id = report_id and r.org_id = (select app.current_org_id())
        and r.status in ('draft', 'returned')
    )
  );
grant select, insert, delete on public.report_material_line to app_user;
grant update (item_id, item_name, qty, unit, unit_cost_minor, cost_source, cost_only, sort)
  on public.report_material_line to app_user;
-- DELETE gated by parent status (draft/returned only) — same heartbeat rule as
-- report_work_line: submitted/reviewed material lines are frozen at the DB.
