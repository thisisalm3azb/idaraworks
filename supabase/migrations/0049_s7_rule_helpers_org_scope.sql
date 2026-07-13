-- 0049_s7_rule_helpers_org_scope (S7 review fix, finding #4): harden the two SECURITY
-- DEFINER candidate helpers from 0048 so a caller can only ever ask about its OWN org.
-- A DEFINER function bypasses RLS, so it must NOT trust its p_org parameter — it has to
-- re-derive the caller's org from the request GUC and assert equality (the same self-check
-- app.refresh_cost_rollup already enforces). Without this, a hostile caller that could reach
-- the function with a foreign uuid would receive another tenant's walled candidate rows.
-- Forward-only: create-or-replace re-defines the bodies in place (signatures unchanged).

create or replace function app.margin_drift_candidates(
  p_org uuid,
  p_margin_points numeric,
  p_cost_of_quote_pct numeric,
  p_prefinal_progress numeric
)
returns table (job_id uuid, cost_pct numeric, progress_pct numeric, arm text)
language sql
security definer
set search_path = public, pg_temp
as $$
  with j as (
    select
      jb.id as job_id,
      crl.total_cost_minor::numeric as cost_minor,
      coalesce(
        (select q.base_total_minor::numeric from public.quote q
         where q.org_id = p_org and q.converted_job_id = jb.id and q.status = 'converted'
         order by q.accepted_at desc nulls last limit 1),
        case when jb.selling_price_minor is null then null
             else jb.selling_price_minor::numeric + coalesce((
               select sum((adj->>'amount_minor')::numeric)
               from jsonb_array_elements(coalesce(jb.price_adjustments, '[]'::jsonb)) adj
             ), 0) end
      ) as quoted_minor,
      (select case
          when sum(s.weight) filter (where s.status <> 'skipped') > 0
          then round(100.0 * sum(
                 s.weight * case s.status when 'completed' then 1 when 'in_progress' then 0.5 else 0 end
               ) filter (where s.status <> 'skipped')
               / sum(s.weight) filter (where s.status <> 'skipped'), 1)
          else null end
        from public.job_stage s where s.job_id = jb.id and s.org_id = p_org) as progress_pct
    from public.job jb
    join public.cost_rollup_labour crl on crl.job_id = jb.id and crl.org_id = p_org
    -- DEFINER self-check (like app.refresh_cost_rollup): a caller may only ask about its
    -- OWN org, never a foreign uuid — the RLS/wall bypass must not trust the parameter.
    where jb.org_id = p_org and p_org = (select app.current_org_id())
      and jb.status_category = 'active' and jb.archived = false
  )
  select
    job_id,
    round(100.0 * cost_minor / quoted_minor, 1) as cost_pct,
    progress_pct,
    case when (100.0 * cost_minor / quoted_minor - progress_pct) > p_margin_points
         then 'drift' else 'prefinal' end as arm
  from j
  where quoted_minor is not null and quoted_minor > 0 and progress_pct is not null
    and (
      (100.0 * cost_minor / quoted_minor - progress_pct) > p_margin_points
      or (100.0 * cost_minor / quoted_minor >= p_cost_of_quote_pct and progress_pct < p_prefinal_progress)
    );
$$;
revoke all on function app.margin_drift_candidates(uuid, numeric, numeric, numeric) from public;
grant execute on function app.margin_drift_candidates(uuid, numeric, numeric, numeric) to app_user;

create or replace function app.document_expiry_candidates(p_org uuid, p_window_days integer)
returns table (employee_id uuid, doc_type text, expiry_date date)
language sql
security definer
set search_path = public, pg_temp
as $$
  select e.id, d.doc_type, d.expiry
  from public.employee e
  join public.employee_hr hr on hr.employee_id = e.id and hr.org_id = p_org
  cross join lateral (values
    ('id', hr.id_expiry),
    ('passport', hr.passport_expiry),
    ('visa', hr.visa_expiry)
  ) as d(doc_type, expiry)
  where e.org_id = p_org and p_org = (select app.current_org_id()) and e.active = true
    and d.expiry is not null
    and d.expiry <= (current_date + p_window_days);
$$;
revoke all on function app.document_expiry_candidates(uuid, integer) from public;
grant execute on function app.document_expiry_candidates(uuid, integer) to app_user;
