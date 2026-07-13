-- 0039_s5_exceptions (S5 — "Measure", part 2 of 3): the materialized exception
-- entity (doc 04 D-4.1) + the nightly-sweep org-discovery helper.
-- Exceptions are MATERIALIZED, not computed-on-read: auditable history, cheap
-- Today reads, per-org dismissal state. Lifecycle: OPEN (resolved_at null) →
-- RESOLVED (resolution auto|dismissed|actioned). The evaluator UPSERTS by dedup_key
-- (= rule + subject + period), so a persisting condition ages as ONE row, never a
-- daily duplicate. No-hard-delete: exceptions resolve, never delete. Forward-only.

create table public.exception (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  -- Closed rule catalogue (doc 04): the S5 core (E-01..E-04, E-07), the C-10
  -- costing-divergence alarm, and the cross-module signals folded in (billing point
  -- reopen from S2 F-5, approval stuck from the S4 E-03 stub).
  rule_key text not null check (rule_key in (
    'missing_report', 'overdue_stage', 'approval_stuck', 'blocking_issue',
    'labour_outlier', 'quote_divergence', 'billing_point_reopened'
  )),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  job_id uuid, -- null for org-level rules
  subject_type text check (subject_type is null or length(subject_type) between 1 and 40),
  subject_id uuid,
  -- Evidence links (records that justify it — "why am I seeing this", Bible §10.6).
  evidence_refs jsonb not null default '[]'::jsonb,
  -- Which archetypes see this exception (doc 04 audience_roles). The service filters
  -- reads by (archetype ∈ audience) ∧ job-scope; RLS is the org backstop.
  audience_roles text[] not null,
  -- rule + subject + period; the partial unique below makes it one-open-per-key.
  dedup_key text not null check (length(dedup_key) between 1 and 200),
  raised_at timestamptz not null default now(),
  last_evaluated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text check (resolution in ('auto', 'dismissed', 'actioned')),
  resolved_by uuid references public.user_profile (id),
  resolution_note text check (resolution_note is null or length(resolution_note) <= 500),
  created_at timestamptz not null default now(),
  constraint exception_id_org_uq unique (id, org_id),
  -- A resolved exception must say HOW it resolved (doc 04 resolution enum).
  constraint exception_resolution_ck check (resolved_at is null or resolution is not null)
);
-- ONE open exception per (org, dedup_key): a second raise while one is open UPSERTS
-- (ages) the existing row instead of duplicating (D-4.1). Historical resolved rows
-- are unconstrained, so the same condition can recur later.
create unique index exception_one_open_per_dedup
  on public.exception (org_id, dedup_key)
  where resolved_at is null;
-- Hot reads: open exceptions for Today/digest, and per-job open exceptions.
create index exception_open_idx on public.exception (org_id, raised_at)
  where resolved_at is null;
create index exception_open_job_idx on public.exception (org_id, job_id)
  where resolved_at is null;
alter table public.exception
  add constraint exception_job_org_fk foreign key (job_id, org_id)
  references public.job (id, org_id) on delete restrict;
alter table public.exception enable row level security;
create policy exception_select on public.exception
  for select to app_user using (org_id = (select app.current_org_id()));
create policy exception_insert on public.exception
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy exception_update on public.exception
  for update to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.exception to app_user;
-- Two mutation paths, both engine/service-controlled: the raise UPSERT ages an open
-- row (severity escalation W→C, refreshed evidence/audience, last_evaluated_at), and
-- clear/dismiss set the resolution fields. The exceptions.dismiss archetype gate
-- (owner/admin/manager) is the SERVICE assertCan; auto-clear is engine-controlled.
-- No DELETE grant (materialized history).
grant update (severity, evidence_refs, audience_roles, last_evaluated_at,
              resolved_at, resolution, resolved_by, resolution_note)
  on public.exception to app_user;

-- ── app.orgs_for_exception_sweep (PLATFORM task — nightly cross-org discovery) ─
-- The nightly evaluator is a platform task (no tenant GUC). It discovers every org
-- with an owner to attribute the sweep to and runs the ORG-SCOPED evaluator per org.
-- Same discipline as app.orgs_with_pending_approvals (0036): SECURITY DEFINER +
-- app.assert_platform_task() so ONLY a no-tenant-context caller may run it.
create or replace function app.orgs_for_exception_sweep()
returns table (org_id uuid, actor_user_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  return query
    select o.id as org_id,
           (
             select m.user_id
             from public.membership m
             join public.role_definition r on r.org_id = m.org_id and r.key = m.role_key
             where m.org_id = o.id and r.archetype = 'owner' and m.deactivated_at is null
             order by m.created_at asc
             limit 1
           ) as actor_user_id
    from public.org o
    where exists (
      select 1 from public.membership m2
      join public.role_definition r2 on r2.org_id = m2.org_id and r2.key = m2.role_key
      where m2.org_id = o.id and r2.archetype = 'owner' and m2.deactivated_at is null
    );
end;
$$;
revoke all on function app.orgs_for_exception_sweep() from public;
grant execute on function app.orgs_for_exception_sweep() to app_user;
