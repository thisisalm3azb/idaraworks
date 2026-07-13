-- 0048_s7_rule_helpers (S7 — "Improve", part 4): SECURITY DEFINER candidate helpers for
-- the two new nightly rules that must read a WALLED table. The nightly evaluator runs on a
-- platform/org ctx that is NOT cost- or HR-privileged, so it cannot (and must not) read the
-- labour rollup or the identity-document table directly. These DEFINER functions do the
-- walled read internally and return ONLY non-sensitive candidate rows (job ids + PERCENTAGES,
-- or employee ids + document type/expiry) — never a raw cost amount or an ID number. This
-- keeps the labour-cost wall (D-6.2) and the owner/admin HR wall intact while letting the
-- engine raise the exception. Forward-only.

-- E-05 margin drift: for each ACTIVE job, compute full cost (incl labour, from the walled
-- rollup) / quoted (C-10 precedence: accepted quote → selling price + audited adjustments)
-- and the U7 DERIVED progress %, and return the jobs that breach either arm. Returns
-- PERCENTAGES only (no raw money crosses the wall into the engine's evidence).
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
    where jb.org_id = p_org and jb.status_category = 'active' and jb.archived = false
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

-- E-13 document expiry: return each ACTIVE employee's ID/passport/visa document that expires
-- within the window (or already has). Reads the owner/admin-walled employee_hr internally;
-- returns only (employee_id, doc_type, expiry) — never the document number.
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
  where e.org_id = p_org and e.active = true
    and d.expiry is not null
    and d.expiry <= (current_date + p_window_days);
$$;
revoke all on function app.document_expiry_candidates(uuid, integer) from public;
grant execute on function app.document_expiry_candidates(uuid, integer) to app_user;
