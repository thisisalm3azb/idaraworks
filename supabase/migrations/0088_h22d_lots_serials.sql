-- 0088_h22d_lots_serials (H22D, part 1)
--
-- Lot and serial identity, and expiry.
--
-- H22A gave `item.tracking` the values 'none', 'lot' and 'serial' and said the
-- ledger would enforce them. It did not: H22B built a ledger with no lot or
-- serial identity at all, so a lot-tracked item posted movements naming no lot
-- and nothing refused them. Worse, `itemCostMethod` returned 'specific' for a
-- serialised item while `planCost` ordered layers by date — specific
-- identification in name, first-in-first-out in behaviour, with no unit to be
-- specific about.
--
-- This migration gives the ledger the identity it was promised, and makes the
-- database refuse a movement that does not carry it.

-- ── 1. Lots ─────────────────────────────────────────────────────────────────
/*
 * A batch of one item that shares an origin and, usually, an expiry.
 *
 * The code is the organization's own; supplier_lot_code records what the
 * supplier called it, because the two are rarely the same and a recall arrives
 * quoting the supplier's.
 */
create table public.stock_lot (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  item_id uuid not null,
  code text not null check (length(trim(code)) between 1 and 64),
  supplier_lot_code text check (supplier_lot_code is null or length(supplier_lot_code) <= 64),
  manufactured_on date,
  expiry_date date,
  received_at timestamptz not null default now(),
  /*
   * 'active' is issuable. The rest are not, each for its own reason, and the
   * reason matters: 'expired' is a fact about time, 'recalled' is a decision
   * somebody made and must be able to explain.
   */
  status text not null default 'active'
    check (status in ('active', 'quarantined', 'expired', 'recalled', 'depleted')),
  notes text check (notes is null or length(notes) <= 2000),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_lot_id_org_uq unique (id, org_id),
  constraint stock_lot_item_org_fk foreign key (item_id, org_id)
    references public.item (id, org_id) on delete restrict,
  -- One code per item per organization: "lot 2026-04" means one batch.
  constraint stock_lot_code_uq unique (org_id, item_id, code),
  constraint stock_lot_dates_ck check (
    expiry_date is null or manufactured_on is null or expiry_date >= manufactured_on
  )
);
create index stock_lot_item_idx on public.stock_lot (org_id, item_id, status, expiry_date);
create index stock_lot_expiry_idx on public.stock_lot (org_id, expiry_date)
  where expiry_date is not null and status = 'active';

alter table public.stock_lot enable row level security;
create policy stock_lot_select on public.stock_lot
  for select to app_user using (org_id = (select app.current_org_id()));
create policy stock_lot_insert on public.stock_lot
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy stock_lot_update on public.stock_lot
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.stock_lot to app_user;
grant update (supplier_lot_code, manufactured_on, expiry_date, status, notes, updated_at)
  on public.stock_lot to app_user;

-- ── 2. Serials ──────────────────────────────────────────────────────────────
/*
 * One physical unit, followed by name.
 *
 * A serial is not a quantity: it is somewhere or it is not, and its whole
 * history is the movements that name it. `location_id` is where it is now and
 * goes null the moment it leaves, so "in stock with no location" is impossible
 * to represent.
 */
create table public.stock_serial (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  item_id uuid not null,
  serial_no text not null check (length(trim(serial_no)) between 1 and 64),
  /** A serialised unit may also belong to a batch. */
  lot_id uuid,
  status text not null default 'in_stock'
    check (status in ('in_stock', 'reserved', 'issued', 'consumed', 'returned', 'scrapped')),
  warehouse_id uuid,
  location_id uuid,
  received_at timestamptz not null default now(),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_serial_id_org_uq unique (id, org_id),
  constraint stock_serial_item_org_fk foreign key (item_id, org_id)
    references public.item (id, org_id) on delete restrict,
  constraint stock_serial_lot_org_fk foreign key (lot_id, org_id)
    references public.stock_lot (id, org_id) on delete restrict,
  constraint stock_serial_warehouse_org_fk foreign key (warehouse_id, org_id)
    references public.warehouse (id, org_id) on delete restrict,
  constraint stock_serial_location_org_fk foreign key (location_id, org_id)
    references public.stock_location (id, org_id) on delete restrict,
  constraint stock_serial_no_uq unique (org_id, item_id, serial_no),
  -- A unit that is here has somewhere to be; one that has left does not.
  constraint stock_serial_placed_ck check (
    (status in ('in_stock', 'reserved')) = (location_id is not null)
  )
);
create index stock_serial_item_idx on public.stock_serial (org_id, item_id, status);
create index stock_serial_location_idx on public.stock_serial (org_id, location_id)
  where location_id is not null;

alter table public.stock_serial enable row level security;
create policy stock_serial_select on public.stock_serial
  for select to app_user using (org_id = (select app.current_org_id()));
create policy stock_serial_insert on public.stock_serial
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy stock_serial_update on public.stock_serial
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.stock_serial to app_user;
grant update (lot_id, status, warehouse_id, location_id, updated_at)
  on public.stock_serial to app_user;

-- ── 3. What a movement moved ────────────────────────────────────────────────
/*
 * The identity a movement carries, as child rows rather than columns.
 *
 * A single issue can span several lots, and an issue of five serialised units
 * names five serials. Columns on stock_movement would force one movement per
 * lot and per unit, which multiplies the ledger by the tracking policy and makes
 * "one business event in one place" impossible to keep.
 *
 * These rows are append-only for the same reason the movements are: they are
 * part of what was recorded, not a working note about it.
 */
create table public.stock_movement_lot (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  movement_id uuid not null,
  lot_id uuid not null,
  -- Signed the same way as the movement: negative leaves, positive arrives.
  qty numeric(20, 6) not null check (qty <> 0),
  created_at timestamptz not null default now(),
  constraint stock_movement_lot_id_org_uq unique (id, org_id),
  constraint stock_movement_lot_movement_fk foreign key (movement_id, org_id)
    references public.stock_movement (id, org_id) on delete restrict,
  constraint stock_movement_lot_lot_fk foreign key (lot_id, org_id)
    references public.stock_lot (id, org_id) on delete restrict,
  -- One line per lot per movement: a second line for the same lot is an
  -- addition nobody can audit, not a second fact.
  constraint stock_movement_lot_once_uq unique (movement_id, lot_id)
);
create index stock_movement_lot_lot_idx on public.stock_movement_lot (org_id, lot_id);

create table public.stock_movement_serial (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  movement_id uuid not null,
  serial_id uuid not null,
  created_at timestamptz not null default now(),
  constraint stock_movement_serial_id_org_uq unique (id, org_id),
  constraint stock_movement_serial_movement_fk foreign key (movement_id, org_id)
    references public.stock_movement (id, org_id) on delete restrict,
  constraint stock_movement_serial_serial_fk foreign key (serial_id, org_id)
    references public.stock_serial (id, org_id) on delete restrict,
  constraint stock_movement_serial_once_uq unique (movement_id, serial_id)
);
create index stock_movement_serial_serial_idx
  on public.stock_movement_serial (org_id, serial_id);

alter table public.stock_movement_lot enable row level security;
create policy stock_movement_lot_select on public.stock_movement_lot
  for select to app_user using (org_id = (select app.current_org_id()));
create policy stock_movement_lot_insert on public.stock_movement_lot
  for insert to app_user with check (org_id = (select app.current_org_id()));
grant select, insert on public.stock_movement_lot to app_user;

alter table public.stock_movement_serial enable row level security;
create policy stock_movement_serial_select on public.stock_movement_serial
  for select to app_user using (org_id = (select app.current_org_id()));
create policy stock_movement_serial_insert on public.stock_movement_serial
  for insert to app_user with check (org_id = (select app.current_org_id()));
grant select, insert on public.stock_movement_serial to app_user;

/*
 * Append-only, enforced for every role including the owner.
 *
 * Same reasoning as stock_movement itself: a posted fact is not editable, and
 * withholding the grant would only stop the roles that ask politely.
 */
create function app.stock_tracking_detail_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'stock movement detail is append-only: a posted % cannot be % (post a reversal instead)',
    tg_table_name, lower(tg_op)
    using errcode = 'restrict_violation';
end;
$$;

create trigger stock_movement_lot_no_update
  before update or delete on public.stock_movement_lot
  for each row execute function app.stock_tracking_detail_is_append_only();
create trigger stock_movement_serial_no_update
  before update or delete on public.stock_movement_serial
  for each row execute function app.stock_tracking_detail_is_append_only();

-- ── 4. The ledger refuses a movement that lacks its identity ────────────────
/*
 * The promise H22A made, kept.
 *
 * This has to be a DEFERRED CONSTRAINT TRIGGER, not an ordinary one: the detail
 * rows are written after the movement they belong to, so a check that fires on
 * the movement's own insert would see none of them and reject everything. Fired
 * at commit, it sees the whole event.
 *
 * A reservation moves nothing physically (qty_delta 0) and so names nothing;
 * that falls out of the arithmetic rather than needing a special case.
 */
create function app.stock_movement_tracking_is_complete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  trk text;
  named numeric;
  units integer;
begin
  select i.tracking into trk
  from public.item i where i.id = new.item_id and i.org_id = new.org_id;

  if trk is null or trk = 'none' then
    if exists (select 1 from public.stock_movement_lot l
               where l.movement_id = new.id and l.org_id = new.org_id)
       or exists (select 1 from public.stock_movement_serial s
                  where s.movement_id = new.id and s.org_id = new.org_id) then
      raise exception
        'movement % names lots or serials, but this item is not tracked that way', new.id
        using errcode = 'check_violation';
    end if;
    return null;
  end if;

  if trk = 'lot' then
    select coalesce(sum(l.qty), 0) into named
    from public.stock_movement_lot l
    where l.movement_id = new.id and l.org_id = new.org_id;
    if named <> new.qty_delta then
      raise exception
        'lot-tracked movement % moves % but its lots account for %',
        new.id, new.qty_delta, named
        using errcode = 'check_violation';
    end if;
    return null;
  end if;

  -- serial
  if new.qty_delta <> trunc(new.qty_delta) then
    raise exception 'a serialised item moves in whole units, not %', new.qty_delta
      using errcode = 'check_violation';
  end if;
  select count(*) into units
  from public.stock_movement_serial s
  where s.movement_id = new.id and s.org_id = new.org_id;
  if units <> abs(new.qty_delta) then
    raise exception
      'serialised movement % moves % unit(s) but names %', new.id, abs(new.qty_delta), units
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
revoke all on function app.stock_movement_tracking_is_complete() from public;

create constraint trigger stock_movement_tracking_complete
  after insert on public.stock_movement
  deferrable initially deferred
  for each row execute function app.stock_movement_tracking_is_complete();

-- ── 5. Where each lot actually is ───────────────────────────────────────────
/*
 * The same projection as stock_balance, one grain finer.
 *
 * Allocation has to answer "which lots are in this bin, and which expires
 * first" on every issue, and deriving that by walking a lot's whole movement
 * history gets slower for exactly the lots that are used most. Like
 * stock_balance, this holds no authority: the ledger is the truth and
 * reconciliation reports drift rather than repairing it.
 */
create table public.stock_lot_balance (
  org_id uuid not null references public.org (id) on delete restrict,
  item_id uuid not null,
  warehouse_id uuid not null,
  location_id uuid not null,
  lot_id uuid not null,
  on_hand numeric(20, 6) not null default 0,
  reserved numeric(20, 6) not null default 0,
  last_movement_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (org_id, item_id, warehouse_id, location_id, lot_id),
  constraint stock_lot_balance_item_org_fk foreign key (item_id, org_id)
    references public.item (id, org_id) on delete restrict,
  constraint stock_lot_balance_warehouse_org_fk foreign key (warehouse_id, org_id)
    references public.warehouse (id, org_id) on delete restrict,
  constraint stock_lot_balance_location_org_fk foreign key (location_id, org_id)
    references public.stock_location (id, org_id) on delete restrict,
  constraint stock_lot_balance_lot_org_fk foreign key (lot_id, org_id)
    references public.stock_lot (id, org_id) on delete restrict,
  constraint stock_lot_balance_reserved_ck check (reserved >= 0)
);
create index stock_lot_balance_lot_idx on public.stock_lot_balance (org_id, lot_id);

alter table public.stock_lot_balance enable row level security;
create policy stock_lot_balance_select on public.stock_lot_balance
  for select to app_user using (org_id = (select app.current_org_id()));
create policy stock_lot_balance_insert on public.stock_lot_balance
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy stock_lot_balance_update on public.stock_lot_balance
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.stock_lot_balance to app_user;
grant update (on_hand, reserved, last_movement_at, updated_at)
  on public.stock_lot_balance to app_user;

comment on table public.stock_lot_balance is
  'A projection of stock_movement_lot, kept for allocation speed and holding no authority. reconcileStockBalances() recomputes it from the ledger and REPORTS differences rather than silently correcting them.';

-- ── 6. Cost follows the unit, not the calendar ──────────────────────────────
/*
 * A cost layer can now belong to a lot or to a single serialised unit.
 *
 * This is what makes specific identification real rather than a label: the
 * layer consumed when a serial is issued is THAT serial's layer, found by its
 * id, not the oldest layer that happens to be open.
 *
 * For a batch-tracked item the layers DRAWN are always those of the batches
 * actually picked, so the layer history follows the physical goods. What is
 * CHARGED still depends on the item's cost method: under first-in-first-out it
 * is the batch's own cost, and under weighted average it is the running
 * average — because batch tracking does not make an item non-interchangeable,
 * and IAS 2.25 permits weighted average for goods that are.
 */
alter table public.stock_cost_layer
  add column lot_id uuid,
  add column serial_id uuid,
  add constraint stock_cost_layer_lot_org_fk foreign key (lot_id, org_id)
    references public.stock_lot (id, org_id) on delete restrict,
  add constraint stock_cost_layer_serial_org_fk foreign key (serial_id, org_id)
    references public.stock_serial (id, org_id) on delete restrict,
  -- A serialised layer is one unit, because that is what a serial is.
  add constraint stock_cost_layer_serial_single_ck
    check (serial_id is null or qty_received = 1);

-- One layer per serial: a unit is received once.
create unique index stock_cost_layer_serial_uq
  on public.stock_cost_layer (org_id, serial_id) where serial_id is not null;
create index stock_cost_layer_lot_idx
  on public.stock_cost_layer (org_id, lot_id) where lot_id is not null;

grant update (qty_remaining, depleted_at) on public.stock_cost_layer to app_user;

-- ── 7. What the delivery note said ──────────────────────────────────────────
/*
 * A receipt of a tracked item has to record WHICH batch or WHICH units arrived,
 * and it has to record it at the moment of receiving — that is the only moment
 * anyone is holding the goods and can read the label.
 *
 * These are the document's own words, kept separate from the ledger identity
 * they become. `stock_lot` is created from a lot line when the receipt is
 * posted; until then the receipt says "lot 24B, expires April" and nothing has
 * entered stock. Keeping the two apart means an unposted or cancelled receipt
 * leaves no phantom batch behind.
 */
create table public.goods_receipt_line_lot (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  grl_id uuid not null,
  lot_code text not null check (length(trim(lot_code)) between 1 and 64),
  supplier_lot_code text check (supplier_lot_code is null or length(supplier_lot_code) <= 64),
  manufactured_on date,
  expiry_date date,
  qty numeric(20, 6) not null check (qty > 0),
  /** Which disposition this batch belongs to, so a damaged batch is separable. */
  disposition text not null default 'accepted'
    check (disposition in ('accepted', 'damaged', 'quarantine')),
  created_at timestamptz not null default now(),
  constraint goods_receipt_line_lot_id_org_uq unique (id, org_id),
  constraint goods_receipt_line_lot_grl_fk foreign key (grl_id, org_id)
    references public.goods_receipt_line (id, org_id) on delete restrict,
  constraint goods_receipt_line_lot_once_uq unique (grl_id, lot_code, disposition),
  constraint goods_receipt_line_lot_dates_ck check (
    expiry_date is null or manufactured_on is null or expiry_date >= manufactured_on
  )
);
create index goods_receipt_line_lot_grl_idx on public.goods_receipt_line_lot (org_id, grl_id);

create table public.goods_receipt_line_serial (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  grl_id uuid not null,
  serial_no text not null check (length(trim(serial_no)) between 1 and 64),
  lot_code text check (lot_code is null or length(lot_code) <= 64),
  disposition text not null default 'accepted'
    check (disposition in ('accepted', 'damaged', 'quarantine')),
  created_at timestamptz not null default now(),
  constraint goods_receipt_line_serial_id_org_uq unique (id, org_id),
  constraint goods_receipt_line_serial_grl_fk foreign key (grl_id, org_id)
    references public.goods_receipt_line (id, org_id) on delete restrict,
  -- One unit cannot arrive twice on the same line.
  constraint goods_receipt_line_serial_once_uq unique (grl_id, serial_no)
);
create index goods_receipt_line_serial_grl_idx
  on public.goods_receipt_line_serial (org_id, grl_id);

alter table public.goods_receipt_line_lot enable row level security;
create policy grl_lot_select on public.goods_receipt_line_lot
  for select to app_user using (org_id = (select app.current_org_id()));
create policy grl_lot_insert on public.goods_receipt_line_lot
  for insert to app_user with check (org_id = (select app.current_org_id()));
grant select, insert on public.goods_receipt_line_lot to app_user;

alter table public.goods_receipt_line_serial enable row level security;
create policy grl_serial_select on public.goods_receipt_line_serial
  for select to app_user using (org_id = (select app.current_org_id()));
create policy grl_serial_insert on public.goods_receipt_line_serial
  for insert to app_user with check (org_id = (select app.current_org_id()));
grant select, insert on public.goods_receipt_line_serial to app_user;

comment on table public.goods_receipt_line_lot is
  'What the delivery note said. Becomes a stock_lot when the receipt is posted; an unposted or cancelled receipt leaves no batch behind.';
