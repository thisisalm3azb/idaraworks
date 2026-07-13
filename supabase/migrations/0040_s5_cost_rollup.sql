-- 0040_s5_cost_rollup (S5 — "Measure", part 3 of 3): the costing spine's cached
-- rollups + their SOLE WRITER (doc 01 costing spine; BUILD_BIBLE §4.8).
-- Derived data is not stored EXCEPT as a cached rollup with a SINGLE WRITER, event
-- invalidation, and a nightly recompute-reconcile alarm. The single writer is the
-- SECURITY DEFINER app.refresh_cost_rollup — app_user has NO write grant on either
-- rollup table, so at the DATABASE there is exactly one writer. The rollup is split
-- to preserve the D-6.2 labour-cost wall: cost_rollup holds the ex-labour figures
-- (service-walled, like PO costs), cost_rollup_labour✱ holds labour + full total
-- behind the RLS cost wall (like report_labour_cost). Forward-only.

-- ── cost_rollup (ex-labour: material + PO + expense) ─────────────────────────
create table public.cost_rollup (
  org_id uuid not null references public.org (id) on delete restrict,
  job_id uuid not null,
  -- The VAT basis this rollup was computed under (ex_vat for VAT-registered orgs,
  -- inc_vat otherwise — F-53/PB-3). Snapshotted so a redacted read knows the basis.
  cost_basis text not null check (cost_basis in ('ex_vat', 'inc_vat')),
  material_cost_minor bigint not null default 0 check (material_cost_minor >= 0),
  po_cost_minor bigint not null default 0 check (po_cost_minor >= 0),
  expense_cost_minor bigint not null default 0 check (expense_cost_minor >= 0),
  total_ex_labour_minor bigint not null default 0 check (total_ex_labour_minor >= 0),
  computed_at timestamptz not null default now(),
  source_version bigint not null default 1,
  primary key (org_id, job_id)
);
alter table public.cost_rollup
  add constraint cost_rollup_job_org_fk foreign key (job_id, org_id)
  references public.job (id, org_id) on delete restrict;
alter table public.cost_rollup enable row level security;
create policy cost_rollup_select on public.cost_rollup
  for select to app_user using (org_id = (select app.current_org_id()));
-- SELECT ONLY. Writes are the DEFINER refresh's monopoly (single-writer, §4.8).
grant select on public.cost_rollup to app_user;

-- ── cost_rollup_labour ✱ (labour + full total — COST-PRIVILEGED wall) ────────
create table public.cost_rollup_labour (
  org_id uuid not null references public.org (id) on delete restrict,
  job_id uuid not null,
  labour_cost_minor bigint not null default 0 check (labour_cost_minor >= 0),
  total_cost_minor bigint not null default 0 check (total_cost_minor >= 0),
  computed_at timestamptz not null default now(),
  primary key (org_id, job_id)
);
alter table public.cost_rollup_labour
  add constraint cost_rollup_labour_job_org_fk foreign key (job_id, org_id)
  references public.job (id, org_id) on delete restrict;
alter table public.cost_rollup_labour enable row level security;
-- The wall: only a cost-privileged session reads labour + full total (D-6.2), same
-- as report_labour_cost. A manager/foreman session reads ZERO rows here.
create policy cost_rollup_labour_select on public.cost_rollup_labour
  for select to app_user
  using (org_id = (select app.current_org_id()) and (select app.is_cost_privileged()));
grant select on public.cost_rollup_labour to app_user;

-- ── app.refresh_cost_rollup (SECURITY DEFINER — the SOLE writer) ─────────────
-- Recomputes a job's cost from source (material manual lines + frozen labour✱ +
-- PO receipts + expenses), applies the VAT basis, and upserts BOTH rollup tables.
-- DEFINER rights cross the labour wall to read report_labour_cost, so a
-- non-cost-privileged worker/manager can trigger a refresh without ever reading
-- labour cost (the RLS wall on cost_rollup_labour stays intact for their SELECTs).
-- Returns TRUE if an existing cached total DRIFTED (a missed invalidation) — the
-- nightly reconcile alarms on that (doc 10 #49 / D-2.2). Org-guarded.
--
-- Dedup (F-2): expenses are disjoint from POs by construction (expense has no
-- po_id). Report material lines count ONLY cost_source='manual' (manual/cost-only
-- consumption); catalog/PO-supplied lines are evidence, excluded — the PO/GRN
-- channel costs those. Both bases share material+labour (no VAT on reports); they
-- differ only on VAT-bearing sources (PO gross-up, expense net-vs-gross).
create or replace function app.refresh_cost_rollup(p_org uuid, p_job uuid, p_basis text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inc boolean := (p_basis = 'inc_vat');
  v_material bigint := 0;
  v_labour bigint := 0;
  v_po_ex bigint := 0;
  v_po_vat bigint := 0;
  v_expense bigint := 0;
  v_po bigint := 0;
  v_total_ex_labour bigint := 0;
  v_total bigint := 0;
  v_old_total bigint;
begin
  if p_org is distinct from app.current_org_id() then
    raise exception 'refresh_cost_rollup: cross-org refresh blocked';
  end if;
  if p_basis not in ('ex_vat', 'inc_vat') then
    raise exception 'refresh_cost_rollup: invalid basis %', p_basis;
  end if;

  -- Material (manual report lines, submitted/reviewed reports).
  select coalesce(sum(round(ml.unit_cost_minor * ml.qty)), 0)::bigint into v_material
  from public.report_material_line ml
  join public.daily_report r on r.id = ml.report_id
  where ml.org_id = p_org and r.org_id = p_org and r.job_id = p_job
    and r.status in ('submitted', 'reviewed')
    and ml.cost_source = 'manual' and ml.unit_cost_minor is not null;

  -- Labour (frozen cost snapshots — DEFINER crosses the wall).
  select coalesce(sum(lc.labour_cost_minor), 0)::bigint into v_labour
  from public.report_labour_cost lc
  join public.daily_report r on r.id = lc.report_id
  where lc.org_id = p_org and r.org_id = p_org and r.job_id = p_job
    and r.status in ('submitted', 'reviewed');

  -- PO receipts (ex-VAT): net received × line unit cost, recorded GRNs on this job's POs.
  select coalesce(sum(
           round((gl.received_qty - gl.damaged_qty - gl.rejected_qty) * pl.unit_cost_minor)
         ), 0)::bigint into v_po_ex
  from public.goods_receipt_line gl
  join public.goods_receipt g on g.id = gl.grn_id and g.status = 'recorded'
  join public.purchase_order po on po.id = g.po_id
  join public.purchase_order_line pl on pl.id = gl.po_line_id
  where gl.org_id = p_org and po.org_id = p_org and po.job_id = p_job;

  -- PO VAT allocation (inc-VAT basis only): each PO's VAT × its received-ex fraction.
  if v_inc then
    select coalesce(sum(
             case when x.subtotal_ex > 0
                  then round(po.vat_minor * x.received_ex / x.subtotal_ex)
                  else 0 end
           ), 0)::bigint into v_po_vat
    from public.purchase_order po
    join lateral (
      select
        (select coalesce(sum(pl.qty * pl.unit_cost_minor), 0)
           from public.purchase_order_line pl where pl.po_id = po.id) as subtotal_ex,
        (select coalesce(sum(
                  round((gl.received_qty - gl.damaged_qty - gl.rejected_qty) * pl2.unit_cost_minor)
                ), 0)
           from public.goods_receipt_line gl
           join public.goods_receipt g on g.id = gl.grn_id and g.status = 'recorded'
           join public.purchase_order_line pl2 on pl2.id = gl.po_line_id
           where pl2.po_id = po.id) as received_ex
    ) x on true
    where po.org_id = p_org and po.job_id = p_job;
  end if;

  -- Expense (job-attributed, non-overhead, non-void): net ex-VAT or gross inc-VAT.
  select coalesce(sum(case when v_inc then e.total_minor else e.amount_minor end), 0)::bigint
    into v_expense
  from public.expense e
  where e.org_id = p_org and e.job_id = p_job and e.voided_at is null
    and e.costing_mapping in ('job_materials', 'job_other');

  v_po := v_po_ex + (case when v_inc then v_po_vat else 0 end);
  v_total_ex_labour := v_material + v_po + v_expense;
  v_total := v_total_ex_labour + v_labour;

  select total_cost_minor into v_old_total
  from public.cost_rollup_labour where org_id = p_org and job_id = p_job;

  insert into public.cost_rollup
    (org_id, job_id, cost_basis, material_cost_minor, po_cost_minor,
     expense_cost_minor, total_ex_labour_minor, computed_at, source_version)
  values (p_org, p_job, p_basis, v_material, v_po, v_expense, v_total_ex_labour, now(), 1)
  on conflict (org_id, job_id) do update set
    cost_basis = excluded.cost_basis,
    material_cost_minor = excluded.material_cost_minor,
    po_cost_minor = excluded.po_cost_minor,
    expense_cost_minor = excluded.expense_cost_minor,
    total_ex_labour_minor = excluded.total_ex_labour_minor,
    computed_at = now(),
    source_version = public.cost_rollup.source_version + 1;

  insert into public.cost_rollup_labour
    (org_id, job_id, labour_cost_minor, total_cost_minor, computed_at)
  values (p_org, p_job, v_labour, v_total, now())
  on conflict (org_id, job_id) do update set
    labour_cost_minor = excluded.labour_cost_minor,
    total_cost_minor = excluded.total_cost_minor,
    computed_at = now();

  return v_old_total is not null and v_old_total is distinct from v_total;
end;
$$;
revoke all on function app.refresh_cost_rollup(uuid, uuid, text) from public;
grant execute on function app.refresh_cost_rollup(uuid, uuid, text) to app_user;
