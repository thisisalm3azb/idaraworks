-- 0085_h22b_stock_ledger (H22B — the immutable stock ledger and its projection)
--
-- The ledger is the source of truth. Everything else about stock is either an
-- input to it or a reading of it.
--
-- THE CENTRAL DECISION: one append-only table of quantity CHANGES, never a
-- quantity that gets edited. "There are 40 in the rack" is not a fact the system
-- stores; it is the sum of every movement that ever touched that rack. A stored
-- number can be wrong in a way nothing detects. A sum cannot: it is either equal
-- to its parts or the parts are visible.
--
-- Corrections are reversals, never edits. A movement is refused UPDATE and
-- DELETE by a trigger that applies to every role, not merely by withholding a
-- grant, because "immutable" that depends on nobody having the right privilege
-- is a convention rather than a property.
--
-- Balances are a PROJECTION, kept for speed. They carry no authority: a
-- reconciliation command recomputes them from the ledger and REPORTS any
-- difference without silently correcting it, because a projection that repairs
-- itself hides the bug that broke it.

-- ── 1. The ledger ───────────────────────────────────────────────────────────
create table public.stock_movement (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,

  item_id uuid not null,
  warehouse_id uuid not null,
  location_id uuid not null,

  /*
   * What happened. The vocabulary is closed: a movement type the system does not
   * know is a bug in the caller, not a new kind of business event to be accepted
   * quietly.
   *
   * Types arriving in later slices (assembly, disassembly, count correction) are
   * declared here so the vocabulary is stable, but nothing posts them until the
   * slice that owns them exists.
   */
  movement_type text not null check (movement_type in (
    'opening_balance',
    'goods_receipt', 'supplier_return',
    'material_issue', 'job_consumption', 'job_return',
    'transfer_out', 'transfer_in',
    'adjustment_increase', 'adjustment_decrease', 'count_correction',
    'reservation', 'reservation_release',
    'assembly_consume', 'assembly_produce',
    'disassembly_consume', 'disassembly_produce',
    'asset_capitalization',
    'reversal'
  )),

  /*
   * The two quantities a movement can change, kept apart because they answer
   * different questions.
   *
   *   qty_delta       — physical stock arriving (+) or leaving (-).
   *   reserved_delta  — stock promised to something (+) or released (-).
   *
   * A reservation moves nothing physically: it posts qty_delta 0 and
   * reserved_delta +n. Issuing against that reservation posts both negative.
   * Keeping them in one table means available stock is arithmetic over one
   * ledger rather than a join between two, and the invariant is simply:
   *   on_hand = sum(qty_delta), reserved = sum(reserved_delta),
   *   available = on_hand - reserved.
   */
  qty_delta numeric(20, 6) not null,
  reserved_delta numeric(20, 6) not null default 0,
  -- A movement that changes nothing is not an event worth recording.
  constraint stock_movement_not_empty_ck check (qty_delta <> 0 or reserved_delta <> 0),

  -- The unit the quantities are stated in. Always the item's base unit at post
  -- time: conversion happens before the ledger, so the ledger never has to.
  unit_id uuid not null,

  /*
   * Cost, captured at the moment of the movement and never recalculated.
   *
   * unit_cost_minor is in `currency`, which may be the supplier's rather than
   * the organization's. base_unit_cost_minor is the same amount converted at
   * `exchange_rate`, frozen here so a later rate change cannot rewrite what an
   * old receipt cost. IAS 2.11: cost is what was paid, not what it would cost
   * today.
   *
   * Null on movements that carry no cost of their own — a reservation, a
   * transfer between two of the organization's own locations.
   */
  currency char(3)
    check (currency is null or currency in ('AED','SAR','QAR','KWD','BHD','OMR','USD','EUR')),
  unit_cost_minor bigint check (unit_cost_minor is null or unit_cost_minor >= 0),
  exchange_rate numeric(18, 8) check (exchange_rate is null or exchange_rate > 0),
  base_unit_cost_minor bigint check (base_unit_cost_minor is null or base_unit_cost_minor >= 0),
  cost_total_minor bigint,

  /*
   * When it HAPPENED versus when it was RECORDED. A receipt entered on Monday
   * for goods that arrived on Friday is dated Friday and recorded Monday, and a
   * valuation "as at" a date must use the first while an audit trail needs the
   * second. One column cannot answer both.
   */
  effective_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),

  -- Where it came from. Validated by trigger below: the row must exist, belong
  -- to this organization, and be of the type claimed.
  source_type text check (source_type in (
    'goods_receipt_line', 'report_material_line', 'stock_transfer',
    'stock_count_line', 'manual'
  )),
  source_id uuid,
  constraint stock_movement_source_pair_ck
    check ((source_type is null) = (source_id is null) or source_type = 'manual'),

  /*
   * Idempotency. A retried request carrying the same key posts nothing the
   * second time, because the unique index below refuses it. This is what makes
   * "post this receipt" safe to call twice, which matters because a network
   * timeout does not tell the caller whether the write landed.
   */
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),

  /** A reversal names the movement it undoes. Nothing else may. */
  reverses_movement_id uuid,
  reason text check (reason is null or length(reason) <= 500),
  note text check (note is null or length(note) <= 2000),

  actor_user_id uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),

  constraint stock_movement_id_org_uq unique (id, org_id),
  constraint stock_movement_item_org_fk foreign key (item_id, org_id)
    references public.item (id, org_id) on delete restrict,
  constraint stock_movement_warehouse_org_fk foreign key (warehouse_id, org_id)
    references public.warehouse (id, org_id) on delete restrict,
  constraint stock_movement_location_org_fk foreign key (location_id, org_id)
    references public.stock_location (id, org_id) on delete restrict,
  constraint stock_movement_unit_org_fk foreign key (unit_id, org_id)
    references public.unit_of_measure (id, org_id) on delete restrict,
  constraint stock_movement_reverses_org_fk foreign key (reverses_movement_id, org_id)
    references public.stock_movement (id, org_id) on delete restrict,
  -- Only a reversal reverses something, and it must say why.
  constraint stock_movement_reversal_ck check (
    (movement_type = 'reversal') = (reverses_movement_id is not null)
  ),
  constraint stock_movement_reversal_reason_ck check (
    movement_type <> 'reversal' or (reason is not null and length(trim(reason)) > 0)
  )
);

-- Idempotency, per organization.
create unique index stock_movement_idempotency_uq
  on public.stock_movement (org_id, idempotency_key);

/*
 * One posting per source event per movement type.
 *
 * This is the protection that stops a receipt line becoming stock twice: not the
 * caller remembering, but the database refusing. Partial, because 'manual' and
 * null sources have no event to be unique about.
 */
create unique index stock_movement_source_event_uq
  on public.stock_movement (org_id, source_type, source_id, movement_type)
  where source_id is not null;

/*
 * A movement can be reversed once. A second reversal of the same movement would
 * double-undo it, which is how a ledger silently goes wrong.
 */
create unique index stock_movement_one_reversal_uq
  on public.stock_movement (org_id, reverses_movement_id)
  where reverses_movement_id is not null;

-- The read paths: balance recomputation walks (item, warehouse, location); the
-- movement timeline walks one item or one location in time order.
create index stock_movement_balance_idx
  on public.stock_movement (org_id, item_id, warehouse_id, location_id);
create index stock_movement_timeline_idx
  on public.stock_movement (org_id, item_id, effective_at desc);
create index stock_movement_location_time_idx
  on public.stock_movement (org_id, location_id, effective_at desc);
create index stock_movement_source_idx
  on public.stock_movement (org_id, source_type, source_id) where source_id is not null;

alter table public.stock_movement enable row level security;
create policy stock_movement_select on public.stock_movement
  for select to app_user using (org_id = (select app.current_org_id()));
create policy stock_movement_insert on public.stock_movement
  for insert to app_user with check (org_id = (select app.current_org_id()));
-- No UPDATE policy and no UPDATE grant: there is no legal edit.
grant select, insert on public.stock_movement to app_user;

/*
 * Append-only, enforced for EVERY role.
 *
 * Withholding the grant stops app_user. It does not stop the table owner, a
 * migration, or a future service that runs privileged. A posted movement is a
 * record of something that happened in the physical world, and the only honest
 * correction is another movement saying it was wrong.
 *
 * session_replication_role = replica disables this, which is deliberate: test
 * teardown and a reviewed data repair need a way through, and both are explicit
 * acts by someone holding the keys rather than an ordinary write.
 */
create function app.stock_movement_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'stock_movement is append-only: % refused. Post a reversal instead.', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger stock_movement_no_update
  before update on public.stock_movement
  for each row execute function app.stock_movement_is_append_only();
create trigger stock_movement_no_delete
  before delete on public.stock_movement
  for each row execute function app.stock_movement_is_append_only();

/*
 * The source reference, validated in the database.
 *
 * (source_type, source_id) points into a different table per type, which no
 * foreign key can express. The document_share validator in 0082 solved the same
 * problem the same way, and for the same reason: an unvalidated uuid can point
 * at nothing, at another organization's row, or at a row of the wrong kind, and
 * the application layer is exactly where that gets forgotten.
 *
 * Fails CLOSED on an unknown type, so widening the check constraint without
 * teaching this function refuses rather than admits.
 */
create function app.validate_stock_movement_source()
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
  elsif new.source_type in ('stock_transfer', 'stock_count_line') then
    -- The tables arrive with H22C. Until then nothing may claim these sources.
    raise exception 'stock_movement source % is not available yet', new.source_type
      using errcode = 'check_violation';
  else
    raise exception 'stock_movement source % is not a known source type', new.source_type
      using errcode = 'check_violation';
  end if;

  if not found then
    -- One message for "no such row" and "another organization's row": which of
    -- the two it is, is not something an error should disclose.
    raise exception 'stock_movement: no % in this organization for the given source_id',
      new.source_type using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;
revoke all on function app.validate_stock_movement_source() from public;

create trigger stock_movement_validate_source
  before insert on public.stock_movement
  for each row execute function app.validate_stock_movement_source();

comment on table public.stock_movement is
  'The append-only stock ledger. Balances are derived from it; it is derived from nothing. Corrections are reversals.';

-- ── 2. The balance projection ───────────────────────────────────────────────
/*
 * A cache of the ledger, kept because summing every movement on every screen is
 * not viable, and holding NO authority whatsoever.
 *
 * The moving-average cost lives here rather than in the ledger because it is a
 * running state, not an event: each receipt updates it, and its value between
 * receipts is a derived thing. FIFO does not use it; layers do.
 */
create table public.stock_balance (
  org_id uuid not null references public.org (id) on delete restrict,
  item_id uuid not null,
  warehouse_id uuid not null,
  location_id uuid not null,

  on_hand numeric(20, 6) not null default 0,
  reserved numeric(20, 6) not null default 0,

  -- Moving weighted average, in the organization's base currency. Null until the
  -- first costed receipt, because an average of nothing is not zero.
  avg_unit_cost_minor bigint check (avg_unit_cost_minor is null or avg_unit_cost_minor >= 0),

  last_movement_at timestamptz,
  updated_at timestamptz not null default now(),

  primary key (org_id, item_id, warehouse_id, location_id),
  constraint stock_balance_item_org_fk foreign key (item_id, org_id)
    references public.item (id, org_id) on delete restrict,
  constraint stock_balance_warehouse_org_fk foreign key (warehouse_id, org_id)
    references public.warehouse (id, org_id) on delete restrict,
  constraint stock_balance_location_org_fk foreign key (location_id, org_id)
    references public.stock_location (id, org_id) on delete restrict,
  -- Reserved stock that does not exist is not a promise, it is a mistake.
  constraint stock_balance_reserved_ck check (reserved >= 0)
);
create index stock_balance_item_idx on public.stock_balance (org_id, item_id);
create index stock_balance_wh_idx on public.stock_balance (org_id, warehouse_id, item_id);

alter table public.stock_balance enable row level security;
create policy stock_balance_select on public.stock_balance
  for select to app_user using (org_id = (select app.current_org_id()));
create policy stock_balance_insert on public.stock_balance
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy stock_balance_update on public.stock_balance
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.stock_balance to app_user;
grant update (on_hand, reserved, avg_unit_cost_minor, last_movement_at, updated_at)
  on public.stock_balance to app_user;

comment on table public.stock_balance is
  'A projection of stock_movement, kept for speed and holding no authority. reconcileStockBalances() recomputes from the ledger and REPORTS differences rather than silently correcting them.';

-- ── 3. Cost layers ──────────────────────────────────────────────────────────
/*
 * What a receipt cost, and how much of it is left.
 *
 * FIFO consumes the oldest layer first. Specific identification consumes THE
 * layer belonging to the serial being issued — which is why a serialised item
 * gets one layer per unit. IAS 2.23 makes specific identification mandatory for
 * items that are not ordinarily interchangeable, so this is not an optimisation
 * but the required treatment for those items.
 *
 * Weighted average does not consume layers; it reads the running average on the
 * balance. Layers are still written under weighted average, because a change of
 * method must not require reconstructing history that was never kept.
 */
create table public.stock_cost_layer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  item_id uuid not null,
  warehouse_id uuid not null,

  -- The receipt that created this layer. Every layer has one.
  source_movement_id uuid not null,

  qty_received numeric(20, 6) not null check (qty_received > 0),
  qty_remaining numeric(20, 6) not null check (qty_remaining >= 0),

  -- Base-currency unit cost, frozen. The layer is what the goods cost, forever.
  unit_cost_minor bigint not null check (unit_cost_minor >= 0),
  currency char(3) not null
    check (currency in ('AED','SAR','QAR','KWD','BHD','OMR','USD','EUR')),
  original_unit_cost_minor bigint check (original_unit_cost_minor is null or original_unit_cost_minor >= 0),
  exchange_rate numeric(18, 8),

  received_at timestamptz not null,
  depleted_at timestamptz,
  created_at timestamptz not null default now(),

  constraint stock_cost_layer_id_org_uq unique (id, org_id),
  constraint stock_cost_layer_item_org_fk foreign key (item_id, org_id)
    references public.item (id, org_id) on delete restrict,
  constraint stock_cost_layer_warehouse_org_fk foreign key (warehouse_id, org_id)
    references public.warehouse (id, org_id) on delete restrict,
  constraint stock_cost_layer_movement_org_fk foreign key (source_movement_id, org_id)
    references public.stock_movement (id, org_id) on delete restrict,
  -- Cannot consume more than arrived.
  constraint stock_cost_layer_remaining_ck check (qty_remaining <= qty_received)
);
-- FIFO's read: oldest layer with stock left, for this item in this warehouse.
create index stock_cost_layer_fifo_idx
  on public.stock_cost_layer (org_id, item_id, warehouse_id, received_at)
  where qty_remaining > 0;
create index stock_cost_layer_movement_idx on public.stock_cost_layer (source_movement_id);

alter table public.stock_cost_layer enable row level security;
create policy stock_cost_layer_select on public.stock_cost_layer
  for select to app_user using (org_id = (select app.current_org_id()));
create policy stock_cost_layer_insert on public.stock_cost_layer
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy stock_cost_layer_update on public.stock_cost_layer
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.stock_cost_layer to app_user;
-- Only the remaining quantity moves. The cost never does.
grant update (qty_remaining, depleted_at) on public.stock_cost_layer to app_user;

/*
 * Which layers an issue consumed, and at what cost. The audit trail behind a job
 * material cost: "this job used 3 at 12.00 and 2 at 13.50" rather than a single
 * averaged number nobody can trace.
 */
create table public.stock_layer_consumption (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  movement_id uuid not null,
  layer_id uuid not null,
  qty numeric(20, 6) not null check (qty > 0),
  unit_cost_minor bigint not null check (unit_cost_minor >= 0),
  created_at timestamptz not null default now(),
  constraint stock_layer_consumption_movement_org_fk foreign key (movement_id, org_id)
    references public.stock_movement (id, org_id) on delete restrict,
  constraint stock_layer_consumption_layer_org_fk foreign key (layer_id, org_id)
    references public.stock_cost_layer (id, org_id) on delete restrict
);
create index stock_layer_consumption_movement_idx
  on public.stock_layer_consumption (org_id, movement_id);
create index stock_layer_consumption_layer_idx
  on public.stock_layer_consumption (org_id, layer_id);

alter table public.stock_layer_consumption enable row level security;
create policy stock_layer_consumption_select on public.stock_layer_consumption
  for select to app_user using (org_id = (select app.current_org_id()));
create policy stock_layer_consumption_insert on public.stock_layer_consumption
  for insert to app_user with check (org_id = (select app.current_org_id()));
grant select, insert on public.stock_layer_consumption to app_user;
-- Append-only like the ledger it explains.
create trigger stock_layer_consumption_no_update
  before update on public.stock_layer_consumption
  for each row execute function app.stock_movement_is_append_only();
create trigger stock_layer_consumption_no_delete
  before delete on public.stock_layer_consumption
  for each row execute function app.stock_movement_is_append_only();
