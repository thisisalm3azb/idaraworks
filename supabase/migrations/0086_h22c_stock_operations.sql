-- 0086_h22c_stock_operations (H22C — transfers, counts, reservations)
--
-- The ledger records what happened to stock. These tables record the BUSINESS
-- DOCUMENTS that caused it: a transfer between warehouses, a stock count and its
-- reviewed variances, a reservation held for a job.
--
-- Each is a header the ledger points back at, which is why the source validator
-- in 0085 already names them and refuses them until now.

-- ── 1. Transfers ────────────────────────────────────────────────────────────
/*
 * A transfer is ONE document with TWO ledger movements. The document exists so a
 * transfer can be seen, printed and reconciled as a single thing rather than as
 * a coincidence of two opposite movements that happen to match.
 *
 * Both movements post in one transaction, so the pair is atomic: a failure
 * leaves neither, never a quantity that has left one place without arriving in
 * the other.
 */
create table public.stock_transfer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,

  from_warehouse_id uuid not null,
  from_location_id uuid not null,
  to_warehouse_id uuid not null,
  to_location_id uuid not null,

  status text not null default 'draft'
    check (status in ('draft', 'in_transit', 'received', 'cancelled')),

  notes text check (notes is null or length(notes) <= 2000),
  cancelled_reason text check (cancelled_reason is null or length(cancelled_reason) <= 500),

  dispatched_at timestamptz,
  dispatched_by uuid references public.user_profile (id),
  received_at timestamptz,
  received_by uuid references public.user_profile (id),

  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint stock_transfer_id_org_uq unique (id, org_id),
  constraint stock_transfer_org_ref_uq unique (org_id, reference),
  constraint stock_transfer_from_wh_fk foreign key (from_warehouse_id, org_id)
    references public.warehouse (id, org_id) on delete restrict,
  constraint stock_transfer_from_loc_fk foreign key (from_location_id, org_id)
    references public.stock_location (id, org_id) on delete restrict,
  constraint stock_transfer_to_wh_fk foreign key (to_warehouse_id, org_id)
    references public.warehouse (id, org_id) on delete restrict,
  constraint stock_transfer_to_loc_fk foreign key (to_location_id, org_id)
    references public.stock_location (id, org_id) on delete restrict,
  -- Moving stock to where it already is is not a transfer, it is a mistake.
  constraint stock_transfer_distinct_ck check (from_location_id <> to_location_id)
);
create index stock_transfer_org_status_idx
  on public.stock_transfer (org_id, status, created_at desc);

create table public.stock_transfer_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  transfer_id uuid not null,
  item_id uuid not null,
  unit_id uuid not null,
  qty numeric(20, 6) not null check (qty > 0),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  constraint stock_transfer_line_id_org_uq unique (id, org_id),
  constraint stock_transfer_line_transfer_fk foreign key (transfer_id, org_id)
    references public.stock_transfer (id, org_id) on delete restrict,
  constraint stock_transfer_line_item_fk foreign key (item_id, org_id)
    references public.item (id, org_id) on delete restrict,
  constraint stock_transfer_line_unit_fk foreign key (unit_id, org_id)
    references public.unit_of_measure (id, org_id) on delete restrict,
  constraint stock_transfer_line_one_per_item_uq unique (transfer_id, item_id)
);
create index stock_transfer_line_transfer_idx
  on public.stock_transfer_line (org_id, transfer_id);

alter table public.stock_transfer enable row level security;
create policy stock_transfer_select on public.stock_transfer
  for select to app_user using (org_id = (select app.current_org_id()));
create policy stock_transfer_insert on public.stock_transfer
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy stock_transfer_update on public.stock_transfer
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.stock_transfer to app_user;
grant update (status, notes, cancelled_reason, dispatched_at, dispatched_by,
              received_at, received_by, updated_at)
  on public.stock_transfer to app_user;

alter table public.stock_transfer_line enable row level security;
create policy stock_transfer_line_select on public.stock_transfer_line
  for select to app_user using (org_id = (select app.current_org_id()));
create policy stock_transfer_line_insert on public.stock_transfer_line
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy stock_transfer_line_update on public.stock_transfer_line
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.stock_transfer_line to app_user;
grant update (qty, sort) on public.stock_transfer_line to app_user;

-- ── 2. Stock counts ─────────────────────────────────────────────────────────
/*
 * A count does NOT rewrite balances.
 *
 * It records what was counted, computes the variance against what the ledger
 * says, and — once a human has reviewed it — posts count_correction MOVEMENTS
 * for the difference. The balance then changes because the ledger changed, which
 * is the only way it is ever allowed to change.
 *
 * `blind` hides the expected quantity from the counter, so the count is evidence
 * rather than confirmation.
 */
create table public.stock_count (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,
  warehouse_id uuid not null,
  /** Null counts the whole warehouse; set narrows it to one place. */
  location_id uuid,
  kind text not null default 'cycle' check (kind in ('cycle', 'full')),
  status text not null default 'draft'
    check (status in ('draft', 'counting', 'review', 'posted', 'cancelled')),
  blind boolean not null default true,
  notes text check (notes is null or length(notes) <= 2000),
  cancelled_reason text check (cancelled_reason is null or length(cancelled_reason) <= 500),

  counted_at timestamptz,
  reviewed_by uuid references public.user_profile (id),
  reviewed_at timestamptz,
  posted_at timestamptz,

  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint stock_count_id_org_uq unique (id, org_id),
  constraint stock_count_org_ref_uq unique (org_id, reference),
  constraint stock_count_wh_fk foreign key (warehouse_id, org_id)
    references public.warehouse (id, org_id) on delete restrict,
  constraint stock_count_loc_fk foreign key (location_id, org_id)
    references public.stock_location (id, org_id) on delete restrict,
  -- Posting is what a review authorises; it cannot happen without one.
  constraint stock_count_posted_reviewed_ck
    check (status <> 'posted' or (reviewed_by is not null and reviewed_at is not null))
);
create index stock_count_org_status_idx on public.stock_count (org_id, status, created_at desc);

create table public.stock_count_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  count_id uuid not null,
  item_id uuid not null,
  location_id uuid not null,
  unit_id uuid not null,
  /** What the ledger said when the sheet was drawn. Evidence, not authority. */
  expected_qty numeric(20, 6),
  /** What a person actually found. Null until counted. */
  counted_qty numeric(20, 6) check (counted_qty is null or counted_qty >= 0),
  /** Why it differs. Required before a variance may be posted. */
  variance_reason text check (variance_reason is null or length(variance_reason) <= 500),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  constraint stock_count_line_id_org_uq unique (id, org_id),
  constraint stock_count_line_count_fk foreign key (count_id, org_id)
    references public.stock_count (id, org_id) on delete restrict,
  constraint stock_count_line_item_fk foreign key (item_id, org_id)
    references public.item (id, org_id) on delete restrict,
  constraint stock_count_line_loc_fk foreign key (location_id, org_id)
    references public.stock_location (id, org_id) on delete restrict,
  constraint stock_count_line_unit_fk foreign key (unit_id, org_id)
    references public.unit_of_measure (id, org_id) on delete restrict,
  constraint stock_count_line_one_per_place_uq unique (count_id, item_id, location_id)
);
create index stock_count_line_count_idx on public.stock_count_line (org_id, count_id);

alter table public.stock_count enable row level security;
create policy stock_count_select on public.stock_count
  for select to app_user using (org_id = (select app.current_org_id()));
create policy stock_count_insert on public.stock_count
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy stock_count_update on public.stock_count
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.stock_count to app_user;
grant update (status, blind, notes, cancelled_reason, counted_at, reviewed_by,
              reviewed_at, posted_at, updated_at)
  on public.stock_count to app_user;

alter table public.stock_count_line enable row level security;
create policy stock_count_line_select on public.stock_count_line
  for select to app_user using (org_id = (select app.current_org_id()));
create policy stock_count_line_insert on public.stock_count_line
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy stock_count_line_update on public.stock_count_line
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.stock_count_line to app_user;
grant update (expected_qty, counted_qty, variance_reason, sort) on public.stock_count_line to app_user;

-- ── 3. Reservations ─────────────────────────────────────────────────────────
/*
 * A promise that stock is spoken for.
 *
 * The QUANTITY effect lives in the ledger as reserved_delta; this table records
 * WHO it is for and whether the promise is still open, so a reservation can be
 * listed, released and reported on. Reserved stock is not moved: on-hand is
 * unchanged and only `available` falls.
 */
create table public.stock_reservation (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  item_id uuid not null,
  warehouse_id uuid not null,
  location_id uuid not null,
  unit_id uuid not null,
  qty numeric(20, 6) not null check (qty > 0),
  /** What it is held for. A job today; the check widens with the vocabulary. */
  for_job_id uuid,
  status text not null default 'open' check (status in ('open', 'issued', 'released', 'expired')),
  expires_at timestamptz,
  released_reason text check (released_reason is null or length(released_reason) <= 500),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_reservation_id_org_uq unique (id, org_id),
  constraint stock_reservation_item_fk foreign key (item_id, org_id)
    references public.item (id, org_id) on delete restrict,
  constraint stock_reservation_wh_fk foreign key (warehouse_id, org_id)
    references public.warehouse (id, org_id) on delete restrict,
  constraint stock_reservation_loc_fk foreign key (location_id, org_id)
    references public.stock_location (id, org_id) on delete restrict,
  constraint stock_reservation_unit_fk foreign key (unit_id, org_id)
    references public.unit_of_measure (id, org_id) on delete restrict,
  constraint stock_reservation_job_fk foreign key (for_job_id, org_id)
    references public.job (id, org_id) on delete restrict
);
create index stock_reservation_open_idx
  on public.stock_reservation (org_id, item_id, warehouse_id) where status = 'open';
create index stock_reservation_job_idx
  on public.stock_reservation (org_id, for_job_id) where for_job_id is not null;

alter table public.stock_reservation enable row level security;
create policy stock_reservation_select on public.stock_reservation
  for select to app_user using (org_id = (select app.current_org_id()));
create policy stock_reservation_insert on public.stock_reservation
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy stock_reservation_update on public.stock_reservation
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.stock_reservation to app_user;
grant update (qty, status, expires_at, released_reason, updated_at)
  on public.stock_reservation to app_user;

-- ── 4. Teach the ledger's source validator about the new tables ─────────────
/*
 * 0085 declared these source types and refused them with "not available yet".
 * They exist now, so the validator learns them — the check constraint and the
 * validator are widened TOGETHER, which is the rule H22.0 established for
 * document_share and which exists so a source can never be accepted before
 * anything can verify it.
 */
create or replace function app.validate_stock_movement_source()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  found boolean;
begin
  if new.source_id is null or new.source_type = 'manual' then
    return new;
  end if;

  if new.source_type = 'goods_receipt_line' then
    select exists (select 1 from public.goods_receipt_line x
                   where x.id = new.source_id and x.org_id = new.org_id) into found;
  elsif new.source_type = 'report_material_line' then
    select exists (select 1 from public.report_material_line x
                   where x.id = new.source_id and x.org_id = new.org_id) into found;
  elsif new.source_type = 'stock_transfer' then
    select exists (select 1 from public.stock_transfer x
                   where x.id = new.source_id and x.org_id = new.org_id) into found;
  elsif new.source_type = 'stock_count_line' then
    select exists (select 1 from public.stock_count_line x
                   where x.id = new.source_id and x.org_id = new.org_id) into found;
  else
    raise exception 'stock_movement source % is not a known source type', new.source_type
      using errcode = 'check_violation';
  end if;

  if not found then
    raise exception 'stock_movement: no % in this organization for the given source_id',
      new.source_type using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;
revoke all on function app.validate_stock_movement_source() from public;

/*
 * A transfer posts two movements from ONE source row, so the
 * one-posting-per-source-event index in 0085 is correct only because the two
 * legs carry different movement_types. Stated here so the pairing is deliberate
 * rather than accidental: (source_id, movement_type) is the real event key.
 */
comment on index public.stock_movement_source_event_uq is
  'One posting per (source event, movement type). A transfer legitimately posts transfer_out and transfer_in from the same stock_transfer id; a receipt line cannot post goods_receipt twice.';

/*
 * report_material_line.deducted_from_inventory stays as it is: FALSE, always.
 *
 * 0028 parked it for "the stock slice", which is this one. It is deliberately
 * not written, for two reasons.
 *
 * First, 0031 restricts UPDATE on that table to reports in draft, returned or
 * submitted state — a reviewed report is protected from edits, and that
 * protection is correct. Consumption legitimately posts for submitted AND
 * reviewed reports, so writing the flag would succeed for some lines and be
 * refused for others, leaving a column that is false for reasons having nothing
 * to do with whether stock moved.
 *
 * Second, and more importantly, the flag would be a SECOND copy of a fact the
 * ledger already holds. A stock_movement with source_type 'report_material_line'
 * and that line's id IS the record that the line was deducted, it exists for
 * every status, and it cannot drift from the movement it describes. A duplicate
 * that can disagree with the ledger is the same mistake as a balance that
 * carries authority.
 *
 * Read deduction by asking the ledger, not this column.
 */
comment on column public.report_material_line.deducted_from_inventory is
  'LEGACY, never written. A material line is deducted when a stock_movement exists with source_type = report_material_line and this line id. Ask the ledger.';
