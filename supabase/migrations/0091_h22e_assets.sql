-- 0091_h22e_assets (H22E)
--
-- The asset register: what the business OWNS and uses, as opposed to what it
-- holds to consume or sell.
--
-- Three things this deliberately does NOT build.
--
-- No second employee model. A custodian is an organization MEMBER, checked
-- against a live membership by the database. People are H23's subject, and a
-- parallel person table here would have to be reconciled with that one later.
--
-- No second work engine. Maintenance is done as a JOB and its TASKS — the ones
-- H21 already made canonical. An asset_maintenance_event points AT that work; it
-- does not reimplement scheduling, assignment or completion.
--
-- No depreciation. Acquisition cost, residual value and useful life are recorded
-- because H24 needs them, and nothing here calculates a charge or calls anything
-- "net book value". Recording the inputs is honest; computing the answer with no
-- policy, no convention and no period close would be a number that looks like
-- accounting and is not.

-- ── 1. Categories ───────────────────────────────────────────────────────────
/*
 * What kind of thing this is, and the defaults that come with the kind.
 *
 * The useful-life and residual figures live here so a new vehicle inherits the
 * fleet's assumptions instead of each one being typed by hand. They are DEFAULTS
 * copied onto the asset at registration, never read through at report time — an
 * asset bought under last year's policy must keep last year's numbers.
 */
create table public.asset_category (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  parent_id uuid,
  code text not null check (length(trim(code)) between 1 and 32),
  name_en text not null check (length(trim(name_en)) between 1 and 120),
  name_ar text check (name_ar is null or length(name_ar) <= 120),
  /** H24 inputs. Nothing in H22 computes a charge from them. */
  default_useful_life_months integer
    check (default_useful_life_months is null or default_useful_life_months > 0),
  default_residual_pct numeric(6, 3)
    check (default_residual_pct is null or (default_residual_pct >= 0 and default_residual_pct < 100)),
  active boolean not null default true,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint asset_category_id_org_uq unique (id, org_id),
  constraint asset_category_code_uq unique (org_id, code),
  constraint asset_category_parent_fk foreign key (parent_id, org_id)
    references public.asset_category (id, org_id) on delete restrict,
  constraint asset_category_not_self_ck check (parent_id is null or parent_id <> id)
);
create index asset_category_org_idx on public.asset_category (org_id, active, code);

alter table public.asset_category enable row level security;
create policy asset_category_select on public.asset_category
  for select to app_user using (org_id = (select app.current_org_id()));
create policy asset_category_insert on public.asset_category
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy asset_category_update on public.asset_category
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.asset_category to app_user;
grant update (parent_id, name_en, name_ar, default_useful_life_months,
              default_residual_pct, active, updated_at)
  on public.asset_category to app_user;

-- ── 2. The asset itself ─────────────────────────────────────────────────────
/*
 * One physical thing the organization owns and uses.
 *
 * Identity is layered on purpose. `asset_no` is the organization's own, unique
 * and sequential, and is what goes on the sticker. `serial_no` is the
 * manufacturer's. `barcode` is whatever the scanner reads, and `code_kind`
 * declares what that string IS rather than guessing from its digits — the same
 * rule the item catalogue follows, because asserting a GS1 licence nobody holds
 * is a claim about the organization, not a formatting choice.
 *
 * A serialised asset RECEIVED into stock keeps its whole inventory history:
 * stock_serial_id and goods_receipt_line_id point back at the unit and the
 * delivery, and nothing here deletes or rewrites either. Registering an asset is
 * an addition to the record, never a replacement of it.
 */
create table public.asset (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  asset_no text not null,
  category_id uuid,

  name_en text not null check (length(trim(name_en)) between 1 and 160),
  name_ar text check (name_ar is null or length(name_ar) <= 160),
  description_en text check (description_en is null or length(description_en) <= 2000),
  description_ar text check (description_ar is null or length(description_ar) <= 2000),

  serial_no text check (serial_no is null or length(trim(serial_no)) between 1 and 64),
  barcode text check (barcode is null or length(trim(barcode)) between 1 and 64),
  code_kind text not null default 'none'
    check (code_kind in ('none', 'gs1_gtin', 'internal')),
  /** Stable string a QR label encodes. Minted at registration, never reused. */
  qr_key text,

  -- Where it came from, and what it cost.
  acquisition_source text not null default 'purchase'
    check (acquisition_source in
      ('purchase', 'transfer_in', 'donation', 'lease', 'built', 'opening_balance')),
  acquired_on date,
  acquisition_cost_minor bigint
    check (acquisition_cost_minor is null or acquisition_cost_minor >= 0),
  currency char(3)
    check (currency is null or currency in ('AED','SAR','QAR','KWD','BHD','OMR','USD','EUR')),
  exchange_rate numeric(18, 8) check (exchange_rate is null or exchange_rate > 0),
  base_acquisition_cost_minor bigint
    check (base_acquisition_cost_minor is null or base_acquisition_cost_minor >= 0),

  /*
   * H24 inputs, recorded and not used. Depreciation needs a policy, a
   * convention and a period close, none of which exist yet — so this slice
   * stores what a later one will need and calculates nothing.
   */
  residual_value_minor bigint check (residual_value_minor is null or residual_value_minor >= 0),
  useful_life_months integer check (useful_life_months is null or useful_life_months > 0),
  depreciation_start_on date,

  -- Where it came from, as records rather than as text.
  supplier_id uuid,
  purchase_order_id uuid,
  goods_receipt_line_id uuid,
  item_id uuid,
  stock_serial_id uuid,

  warranty_start_on date,
  warranty_end_on date,
  warranty_provider text check (warranty_provider is null or length(warranty_provider) <= 160),
  warranty_terms text check (warranty_terms is null or length(warranty_terms) <= 2000),

  -- Where it lives and who holds it. Both are the CURRENT answer; the history is
  -- in asset_assignment, which is append-only.
  warehouse_id uuid,
  location_id uuid,
  site_note text check (site_note is null or length(site_note) <= 200),
  custodian_user_id uuid references public.user_profile (id),
  custodian_since timestamptz,

  /*
   * The lifecycle. Legal transitions are enforced by a trigger below rather than
   * by whichever service happens to write, because "which states may follow
   * which" is a property of the asset, not of one code path.
   */
  status text not null default 'draft'
    check (status in
      ('draft', 'in_service', 'in_storage', 'under_maintenance', 'in_transit',
       'lost', 'retired', 'disposed')),
  condition text not null default 'good'
    check (condition in ('new', 'good', 'fair', 'poor', 'unserviceable')),

  retired_at timestamptz,
  retired_reason text check (retired_reason is null or length(retired_reason) <= 500),
  disposed_at timestamptz,

  notes text check (notes is null or length(notes) <= 2000),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint asset_id_org_uq unique (id, org_id),
  constraint asset_no_uq unique (org_id, asset_no),
  constraint asset_category_fk foreign key (category_id, org_id)
    references public.asset_category (id, org_id) on delete restrict,
  constraint asset_supplier_fk foreign key (supplier_id, org_id)
    references public.supplier (id, org_id) on delete restrict,
  constraint asset_po_fk foreign key (purchase_order_id, org_id)
    references public.purchase_order (id, org_id) on delete restrict,
  constraint asset_grl_fk foreign key (goods_receipt_line_id, org_id)
    references public.goods_receipt_line (id, org_id) on delete restrict,
  constraint asset_item_fk foreign key (item_id, org_id)
    references public.item (id, org_id) on delete restrict,
  constraint asset_serial_fk foreign key (stock_serial_id, org_id)
    references public.stock_serial (id, org_id) on delete restrict,
  constraint asset_warehouse_fk foreign key (warehouse_id, org_id)
    references public.warehouse (id, org_id) on delete restrict,
  constraint asset_location_fk foreign key (location_id, org_id)
    references public.stock_location (id, org_id) on delete restrict,

  -- One serialised unit becomes at most one asset.
  constraint asset_serial_once_uq unique (org_id, stock_serial_id),
  constraint asset_warranty_ck check (
    warranty_end_on is null or warranty_start_on is null or warranty_end_on >= warranty_start_on
  ),
  -- A custodian is a moment as well as a person: neither half means anything alone.
  constraint asset_custodian_ck check ((custodian_user_id is null) = (custodian_since is null)),
  -- Retired means somebody retired it, on a date. Written plainly rather than as
  -- a boolean comparison, because a constraint nobody can read is not a guard.
  constraint asset_retired_ck check (status <> 'retired' or retired_at is not null),
  constraint asset_disposed_ck check ((status = 'disposed') = (disposed_at is not null)),
  -- Residual value is what is left at the END of a life, so it cannot exceed the cost.
  constraint asset_residual_ck check (
    residual_value_minor is null or acquisition_cost_minor is null
    or residual_value_minor <= acquisition_cost_minor
  )
);
create index asset_org_status_idx on public.asset (org_id, status, asset_no);
create index asset_org_category_idx on public.asset (org_id, category_id, status);
create index asset_custodian_idx on public.asset (org_id, custodian_user_id)
  where custodian_user_id is not null;
create index asset_location_idx on public.asset (org_id, location_id) where location_id is not null;
-- Identity lookups a scanner makes. Partial, because most assets carry neither.
create unique index asset_barcode_uq on public.asset (org_id, barcode) where barcode is not null;
create unique index asset_qr_uq on public.asset (org_id, qr_key) where qr_key is not null;
create index asset_serial_lookup_idx on public.asset (org_id, serial_no) where serial_no is not null;
-- Search: name and asset number, bounded and organization scoped by the caller.
create index asset_search_idx on public.asset
  using gin (to_tsvector('simple', coalesce(name_en, '') || ' ' || coalesce(asset_no, '')));

alter table public.asset enable row level security;
create policy asset_select on public.asset
  for select to app_user using (org_id = (select app.current_org_id()));
create policy asset_insert on public.asset
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy asset_update on public.asset
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.asset to app_user;
grant update (
  category_id, name_en, name_ar, description_en, description_ar,
  serial_no, barcode, code_kind, qr_key,
  acquired_on, acquisition_cost_minor, currency, exchange_rate, base_acquisition_cost_minor,
  residual_value_minor, useful_life_months, depreciation_start_on,
  supplier_id, purchase_order_id, goods_receipt_line_id, item_id, stock_serial_id,
  warranty_start_on, warranty_end_on, warranty_provider, warranty_terms,
  warehouse_id, location_id, site_note, custodian_user_id, custodian_since,
  status, condition, retired_at, retired_reason, disposed_at, notes, updated_at
) on public.asset to app_user;

comment on column public.asset.residual_value_minor is
  'An H24 input. H22 records it and computes no depreciation: there is no policy, convention or period close to compute one against.';

/*
 * A custodian must be a member of THIS organization.
 *
 * A plain foreign key to user_profile would let any user in the system hold an
 * asset, because user_profile is global. Membership is what makes somebody part
 * of an organization, and checking it here rather than in a service means it
 * holds for every writer including a future import.
 */
create function app.asset_custodian_is_a_member()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.custodian_user_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.membership m
    where m.user_id = new.custodian_user_id and m.org_id = new.org_id
      and m.deactivated_at is null
  ) then
    raise exception 'a custodian must be an active member of this organization'
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;
revoke all on function app.asset_custodian_is_a_member() from public;

create trigger asset_custodian_member
  before insert or update of custodian_user_id, org_id on public.asset
  for each row execute function app.asset_custodian_is_a_member();

/*
 * Which states may follow which.
 *
 * Enforced here because it is a property of an asset, not of the one service
 * that happens to be writing. The rules that matter:
 *
 *   - disposed is FINAL. A disposed asset is history, and history is readable
 *     but not editable.
 *   - retired may still be disposed of, or brought back into service if the
 *     retirement was a mistake — but coming back is a state change somebody has
 *     to make deliberately, not a side effect.
 *   - a draft asset has not entered the register yet, so it may go anywhere.
 */
create function app.asset_status_transition_is_legal()
returns trigger
language plpgsql
as $$
declare
  allowed text[];
begin
  if new.status = old.status then
    return new;
  end if;

  allowed := case old.status
    when 'draft' then array['in_service', 'in_storage', 'lost', 'retired']
    when 'in_service' then array['in_storage', 'under_maintenance', 'in_transit', 'lost', 'retired']
    when 'in_storage' then array['in_service', 'under_maintenance', 'in_transit', 'lost', 'retired']
    when 'under_maintenance' then array['in_service', 'in_storage', 'lost', 'retired']
    when 'in_transit' then array['in_service', 'in_storage', 'lost', 'retired']
    when 'lost' then array['in_service', 'in_storage', 'retired']
    when 'retired' then array['in_service', 'in_storage', 'disposed']
    when 'disposed' then array[]::text[]
    else array[]::text[]
  end;

  if not (new.status = any(allowed)) then
    raise exception 'an asset cannot go from % to %', old.status, new.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger asset_status_transition
  before update of status on public.asset
  for each row execute function app.asset_status_transition_is_legal();

/*
 * A disposed asset is history.
 *
 * Readable forever, editable by nobody. Anything that needs saying afterwards is
 * said in a correcting event with its own author and timestamp, not by quietly
 * changing what the record has said since the day it was disposed of.
 */
create function app.asset_disposed_is_read_only()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'disposed' then
    raise exception
      'asset % has been disposed of; its record is history and cannot be edited', old.asset_no
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger asset_disposed_read_only
  before update on public.asset
  for each row when (old.status = 'disposed' and new.status = 'disposed')
  execute function app.asset_disposed_is_read_only();

-- ── 3. Custody, as events ───────────────────────────────────────────────────
/*
 * Who held it, where it was, and when it changed — append-only.
 *
 * asset.custodian_user_id is the CURRENT answer and a convenience; this is the
 * record. A correction is a further event with its own reason, because "who had
 * the drill in March" is exactly the question an editable field cannot answer.
 */
create table public.asset_assignment (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  asset_id uuid not null,
  event text not null
    check (event in ('assigned', 'returned', 'transferred', 'lost', 'found', 'correction')),
  from_user_id uuid references public.user_profile (id),
  to_user_id uuid references public.user_profile (id),
  from_warehouse_id uuid,
  from_location_id uuid,
  to_warehouse_id uuid,
  to_location_id uuid,
  condition_at_event text
    check (condition_at_event is null
           or condition_at_event in ('new', 'good', 'fair', 'poor', 'unserviceable')),
  reason text check (reason is null or length(reason) <= 500),
  /** The event this one corrects, for a mistake that has to be undone. */
  corrects_id uuid,
  effective_at timestamptz not null default now(),
  recorded_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint asset_assignment_id_org_uq unique (id, org_id),
  constraint asset_assignment_asset_fk foreign key (asset_id, org_id)
    references public.asset (id, org_id) on delete restrict,
  constraint asset_assignment_from_wh_fk foreign key (from_warehouse_id, org_id)
    references public.warehouse (id, org_id) on delete restrict,
  constraint asset_assignment_to_wh_fk foreign key (to_warehouse_id, org_id)
    references public.warehouse (id, org_id) on delete restrict,
  constraint asset_assignment_from_loc_fk foreign key (from_location_id, org_id)
    references public.stock_location (id, org_id) on delete restrict,
  constraint asset_assignment_to_loc_fk foreign key (to_location_id, org_id)
    references public.stock_location (id, org_id) on delete restrict,
  constraint asset_assignment_corrects_fk foreign key (corrects_id, org_id)
    references public.asset_assignment (id, org_id) on delete restrict,
  constraint asset_assignment_corrects_ck
    check ((event = 'correction') = (corrects_id is not null)),
  -- An assignment hands the thing to somebody; a return takes it back.
  constraint asset_assignment_shape_ck check (
    (event <> 'assigned' or to_user_id is not null)
    and (event <> 'returned' or from_user_id is not null)
  )
);
create index asset_assignment_asset_idx
  on public.asset_assignment (org_id, asset_id, effective_at desc);
create index asset_assignment_user_idx on public.asset_assignment (org_id, to_user_id)
  where to_user_id is not null;

alter table public.asset_assignment enable row level security;
create policy asset_assignment_select on public.asset_assignment
  for select to app_user using (org_id = (select app.current_org_id()));
create policy asset_assignment_insert on public.asset_assignment
  for insert to app_user with check (org_id = (select app.current_org_id()));
grant select, insert on public.asset_assignment to app_user;

-- ── 4. Inspections ──────────────────────────────────────────────────────────
create table public.asset_inspection (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  asset_id uuid not null,
  inspected_on date not null,
  inspected_by uuid not null references public.user_profile (id),
  kind text not null default 'routine'
    check (kind in ('routine', 'safety', 'calibration', 'pre_use', 'handover', 'incident')),
  passed boolean not null,
  condition_found text not null
    check (condition_found in ('new', 'good', 'fair', 'poor', 'unserviceable')),
  findings text check (findings is null or length(findings) <= 2000),
  next_due_on date,
  /** The work raised because of what was found, if any. Canonical H21 job. */
  job_id uuid,
  recorded_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint asset_inspection_id_org_uq unique (id, org_id),
  constraint asset_inspection_asset_fk foreign key (asset_id, org_id)
    references public.asset (id, org_id) on delete restrict,
  constraint asset_inspection_job_fk foreign key (job_id, org_id)
    references public.job (id, org_id) on delete restrict,
  constraint asset_inspection_next_ck check (next_due_on is null or next_due_on >= inspected_on)
);
create index asset_inspection_asset_idx
  on public.asset_inspection (org_id, asset_id, inspected_on desc);
create index asset_inspection_due_idx on public.asset_inspection (org_id, next_due_on)
  where next_due_on is not null;

alter table public.asset_inspection enable row level security;
create policy asset_inspection_select on public.asset_inspection
  for select to app_user using (org_id = (select app.current_org_id()));
create policy asset_inspection_insert on public.asset_inspection
  for insert to app_user with check (org_id = (select app.current_org_id()));
grant select, insert on public.asset_inspection to app_user;

-- ── 5. Maintenance: the schedule, and the work ──────────────────────────────
/*
 * A plan says WHEN something is due. It does not say who does it or track their
 * progress — that is a job, and jobs already exist.
 */
create table public.asset_maintenance_plan (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  asset_id uuid not null,
  name_en text not null check (length(trim(name_en)) between 1 and 160),
  name_ar text check (name_ar is null or length(name_ar) <= 160),
  kind text not null default 'preventive'
    check (kind in ('preventive', 'calibration', 'inspection', 'statutory')),
  /** Every N days, or every N usage units, or both — at least one is required. */
  interval_days integer check (interval_days is null or interval_days > 0),
  interval_usage numeric(20, 6) check (interval_usage is null or interval_usage > 0),
  usage_unit text check (usage_unit is null or length(usage_unit) <= 24),
  instructions text check (instructions is null or length(instructions) <= 4000),
  next_due_on date,
  last_done_on date,
  active boolean not null default true,
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint asset_maintenance_plan_id_org_uq unique (id, org_id),
  constraint asset_maintenance_plan_asset_fk foreign key (asset_id, org_id)
    references public.asset (id, org_id) on delete restrict,
  constraint asset_maintenance_plan_interval_ck
    check (interval_days is not null or interval_usage is not null),
  constraint asset_maintenance_plan_usage_ck
    check (interval_usage is null or usage_unit is not null)
);
create index asset_maintenance_plan_asset_idx
  on public.asset_maintenance_plan (org_id, asset_id, active);
create index asset_maintenance_plan_due_idx
  on public.asset_maintenance_plan (org_id, next_due_on) where active and next_due_on is not null;

alter table public.asset_maintenance_plan enable row level security;
create policy asset_maintenance_plan_select on public.asset_maintenance_plan
  for select to app_user using (org_id = (select app.current_org_id()));
create policy asset_maintenance_plan_insert on public.asset_maintenance_plan
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy asset_maintenance_plan_update on public.asset_maintenance_plan
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.asset_maintenance_plan to app_user;
grant update (name_en, name_ar, kind, interval_days, interval_usage, usage_unit,
              instructions, next_due_on, last_done_on, active, updated_at)
  on public.asset_maintenance_plan to app_user;

/*
 * One occasion of maintenance, pointing at the work that did it.
 *
 * job_id and task_id are the CANONICAL H21 records — this table adds the asset
 * dimension to work that already exists, rather than becoming a second place
 * where work is scheduled, assigned and completed. Deleting this row would not
 * delete the job, and completing the job is what completing the work means.
 */
create table public.asset_maintenance_event (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  asset_id uuid not null,
  plan_id uuid,
  kind text not null default 'corrective'
    check (kind in ('preventive', 'corrective', 'calibration', 'inspection', 'statutory')),
  /** The canonical work. Null while the event is only a record of what happened. */
  job_id uuid,
  task_id uuid,
  performed_on date not null,
  performed_by uuid references public.user_profile (id),
  vendor_supplier_id uuid,
  cost_minor bigint check (cost_minor is null or cost_minor >= 0),
  currency char(3)
    check (currency is null or currency in ('AED','SAR','QAR','KWD','BHD','OMR','USD','EUR')),
  meter_reading numeric(20, 6) check (meter_reading is null or meter_reading >= 0),
  notes text check (notes is null or length(notes) <= 2000),
  recorded_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  constraint asset_maintenance_event_id_org_uq unique (id, org_id),
  constraint asset_maintenance_event_asset_fk foreign key (asset_id, org_id)
    references public.asset (id, org_id) on delete restrict,
  constraint asset_maintenance_event_plan_fk foreign key (plan_id, org_id)
    references public.asset_maintenance_plan (id, org_id) on delete restrict,
  constraint asset_maintenance_event_job_fk foreign key (job_id, org_id)
    references public.job (id, org_id) on delete restrict,
  constraint asset_maintenance_event_task_fk foreign key (task_id, org_id)
    references public.task (id, org_id) on delete restrict,
  constraint asset_maintenance_event_vendor_fk foreign key (vendor_supplier_id, org_id)
    references public.supplier (id, org_id) on delete restrict,
  -- A task belongs to a job; naming one without the other loses the link.
  constraint asset_maintenance_event_work_ck check (task_id is null or job_id is not null)
);
create index asset_maintenance_event_asset_idx
  on public.asset_maintenance_event (org_id, asset_id, performed_on desc);
create index asset_maintenance_event_job_idx on public.asset_maintenance_event (org_id, job_id)
  where job_id is not null;

alter table public.asset_maintenance_event enable row level security;
create policy asset_maintenance_event_select on public.asset_maintenance_event
  for select to app_user using (org_id = (select app.current_org_id()));
create policy asset_maintenance_event_insert on public.asset_maintenance_event
  for insert to app_user with check (org_id = (select app.current_org_id()));
grant select, insert on public.asset_maintenance_event to app_user;

comment on table public.asset_maintenance_event is
  'The asset dimension of work that lives in job/task. Not a second work engine: scheduling, assignment and completion stay in H21.';

-- ── 6. Downtime ─────────────────────────────────────────────────────────────
/*
 * Time the asset could not be used, which is not the same as time it was being
 * maintained. A machine waiting three weeks for a part is down and nobody is
 * working on it; recording only maintenance would say it was available.
 */
create table public.asset_downtime (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  asset_id uuid not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  reason text not null default 'breakdown'
    check (reason in ('breakdown', 'maintenance', 'awaiting_parts', 'awaiting_approval',
                      'inspection', 'transport', 'other')),
  detail text check (detail is null or length(detail) <= 1000),
  maintenance_event_id uuid,
  recorded_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint asset_downtime_id_org_uq unique (id, org_id),
  constraint asset_downtime_asset_fk foreign key (asset_id, org_id)
    references public.asset (id, org_id) on delete restrict,
  constraint asset_downtime_event_fk foreign key (maintenance_event_id, org_id)
    references public.asset_maintenance_event (id, org_id) on delete restrict,
  constraint asset_downtime_window_ck check (ended_at is null or ended_at >= started_at)
);
create index asset_downtime_asset_idx on public.asset_downtime (org_id, asset_id, started_at desc);
-- One open spell at a time: an asset already down cannot break again first.
create unique index asset_downtime_open_uq on public.asset_downtime (org_id, asset_id)
  where ended_at is null;

alter table public.asset_downtime enable row level security;
create policy asset_downtime_select on public.asset_downtime
  for select to app_user using (org_id = (select app.current_org_id()));
create policy asset_downtime_insert on public.asset_downtime
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy asset_downtime_update on public.asset_downtime
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.asset_downtime to app_user;
-- Only the closing of a spell, and what it was about. The start never moves.
grant update (ended_at, detail, maintenance_event_id, updated_at)
  on public.asset_downtime to app_user;

-- ── 7. Disposal: asked for, approved, then done ─────────────────────────────
/*
 * Getting rid of something the business owns is three separate acts by
 * (usually) different people: somebody proposes it with a reason, somebody with
 * authority approves it, and somebody carries it out and records what actually
 * happened. Collapsing those into one "delete" is how assets leave the books
 * with nobody accountable.
 *
 * The approval itself runs through the existing engine — the same routing,
 * self-approval guard and audit as a purchase order.
 */
create table public.asset_disposal (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  asset_id uuid not null,
  reference text not null,
  method text not null
    check (method in ('sale', 'scrap', 'donation', 'trade_in', 'write_off', 'returned_to_lessor')),
  reason text not null check (length(trim(reason)) between 1 and 1000),
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected', 'completed', 'cancelled')),

  proposed_proceeds_minor bigint
    check (proposed_proceeds_minor is null or proposed_proceeds_minor >= 0),
  actual_proceeds_minor bigint
    check (actual_proceeds_minor is null or actual_proceeds_minor >= 0),
  currency char(3)
    check (currency is null or currency in ('AED','SAR','QAR','KWD','BHD','OMR','USD','EUR')),
  buyer_name text check (buyer_name is null or length(buyer_name) <= 160),
  disposed_on date,

  requested_by uuid not null references public.user_profile (id),
  requested_at timestamptz not null default now(),
  decided_by uuid references public.user_profile (id),
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 1000),
  completed_by uuid references public.user_profile (id),
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint asset_disposal_id_org_uq unique (id, org_id),
  constraint asset_disposal_ref_uq unique (org_id, reference),
  constraint asset_disposal_asset_fk foreign key (asset_id, org_id)
    references public.asset (id, org_id) on delete restrict,
  constraint asset_disposal_decided_ck check ((decided_at is null) = (decided_by is null)),
  constraint asset_disposal_completed_ck check ((status = 'completed') = (completed_at is not null)),
  constraint asset_disposal_proceeds_ck check (
    method <> 'sale' or status <> 'completed' or actual_proceeds_minor is not null
  )
);
-- One live request per asset: two people disposing of the same thing at once is
-- a conflict somebody must resolve, not a race for the database to settle.
create unique index asset_disposal_open_uq on public.asset_disposal (org_id, asset_id)
  where status in ('draft', 'submitted', 'approved');
create index asset_disposal_org_idx on public.asset_disposal (org_id, status, requested_at desc);

alter table public.asset_disposal enable row level security;
create policy asset_disposal_select on public.asset_disposal
  for select to app_user using (org_id = (select app.current_org_id()));
create policy asset_disposal_insert on public.asset_disposal
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy asset_disposal_update on public.asset_disposal
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.asset_disposal to app_user;
grant update (status, proposed_proceeds_minor, actual_proceeds_minor, currency, buyer_name,
              disposed_on, decided_by, decided_at, decision_note, completed_by, completed_at,
              cancelled_at, updated_at)
  on public.asset_disposal to app_user;

/*
 * A decided disposal is history too.
 *
 * Once it has been completed or rejected, the money and the reason it records
 * are what happened. A later change of mind is a new request, not an edit.
 */
create function app.asset_disposal_is_final()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('completed', 'rejected', 'cancelled') then
    raise exception 'a % disposal is final; raise a new request instead', old.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger asset_disposal_final
  before update on public.asset_disposal
  for each row execute function app.asset_disposal_is_final();

-- ── 8. What the platform already knows about ────────────────────────────────
-- Disposal routes through the SAME approval engine as everything else.
alter table public.approval drop constraint if exists approval_subject_type_check;
alter table public.approval
  add constraint approval_subject_type_check check (subject_type in (
    'material_request', 'expense', 'quote_send', 'purchase_order', 'payment',
    'task_completion', 'asset_disposal'
  ));
alter table public.approval_rule drop constraint if exists approval_rule_subject_type_check;
alter table public.approval_rule
  add constraint approval_rule_subject_type_check check (subject_type in (
    'material_request', 'expense', 'quote_send', 'purchase_order', 'payment',
    'task_completion', 'asset_disposal'
  ));

/*
 * Photographs, manuals, warranty certificates and disposal evidence hang off the
 * existing `file` table rather than a second attachment mechanism.
 *
 * No schema change is needed: `file.attached_to_type` is plain text with the
 * ATTACHABLE_TYPES registry as its enforcement point, so adding 'asset' there is
 * the whole change. Retrofitting a CHECK over the full list was tempting and is
 * deliberately not done here — it would validate against every file row in
 * production, and a migration that can abort a deploy over data it did not
 * create belongs in a slice that has looked at that data.
 */
