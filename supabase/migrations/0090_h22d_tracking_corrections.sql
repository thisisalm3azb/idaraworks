-- 0090_h22d_tracking_corrections (H22D, part 3)
--
-- Making lot and serial identity work everywhere a movement can happen.
--
-- 0088 gave the ledger the identity it was promised and made the database refuse
-- a movement without it. That check was correct and it broke four paths that had
-- no way to supply it: transfers, stock counts, assembly output and disassembly
-- output. A constraint that cannot be satisfied is not a safeguard, it is an
-- outage, so this migration gives each of those paths somewhere to record what
-- it moved.
--
-- It also closes three holes 0088 left open: a movement could name another
-- item's batch, detail rows could be appended to an already-committed movement,
-- and a serialised unit could never be received a second time after being
-- issued.

-- ── 1. A count says WHICH batch or unit it counted ──────────────────────────
/*
 * Counting a tracked item is not counting a number.
 *
 * "There are 40 boxes" is not a countable fact for a batch-tracked medicine: 40
 * of WHICH batch, expiring when? The count line therefore names the identity it
 * counted, and a tracked item is counted one line per batch or per unit.
 */
alter table public.stock_count_line
  add column lot_id uuid,
  add column serial_id uuid,
  add constraint stock_count_line_lot_org_fk foreign key (lot_id, org_id)
    references public.stock_lot (id, org_id) on delete restrict,
  add constraint stock_count_line_serial_org_fk foreign key (serial_id, org_id)
    references public.stock_serial (id, org_id) on delete restrict,
  -- A line counts a batch or a unit, never both.
  add constraint stock_count_line_identity_ck check (lot_id is null or serial_id is null);

-- The existing uniqueness was one line per item per location, which cannot hold
-- once a line names a batch: a location holding three batches needs three lines.
alter table public.stock_count_line drop constraint if exists stock_count_line_one_per_place_uq;
create unique index stock_count_line_untracked_uq
  on public.stock_count_line (count_id, item_id, location_id)
  where lot_id is null and serial_id is null;
create unique index stock_count_line_lot_uq
  on public.stock_count_line (count_id, item_id, location_id, lot_id)
  where lot_id is not null;
create unique index stock_count_line_serial_uq
  on public.stock_count_line (count_id, serial_id)
  where serial_id is not null;

grant update (lot_id, serial_id) on public.stock_count_line to app_user;

-- ── 2. A build says what it made ────────────────────────────────────────────
/*
 * Producing a tracked item mints its identity, and somebody has to say what that
 * identity is.
 *
 * A batch made today is a new batch with today's date and its own expiry; units
 * coming off a line get serial numbers somebody assigns. Neither can be derived,
 * so both are recorded on the order before it is completed — which also means an
 * order that cannot say what it will produce is refused while it is still a
 * plan, not halfway through consuming its components.
 */
alter table public.assembly_order
  add column output_lot_code text
    check (output_lot_code is null or length(trim(output_lot_code)) between 1 and 64),
  add column output_manufactured_on date,
  add column output_expiry_date date,
  add constraint assembly_order_output_dates_ck check (
    output_expiry_date is null or output_manufactured_on is null
    or output_expiry_date >= output_manufactured_on
  );

/*
 * Which batch a recovered component goes back into.
 *
 * A part recovered from a teardown is NOT the batch it was built from: its
 * history now includes having been inside something else, and the batch it came
 * from may have been consumed months ago. So disassembly opens a recovery batch,
 * named here or derived from the order's reference.
 */
alter table public.assembly_order_line
  add column output_lot_code text
    check (output_lot_code is null or length(trim(output_lot_code)) between 1 and 64);

create table public.assembly_order_serial (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  order_id uuid not null,
  /** Null means the parent being assembled; set means that component recovered. */
  order_line_id uuid,
  serial_no text not null check (length(trim(serial_no)) between 1 and 64),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  constraint assembly_order_serial_id_org_uq unique (id, org_id),
  constraint assembly_order_serial_order_fk foreign key (order_id, org_id)
    references public.assembly_order (id, org_id) on delete restrict,
  constraint assembly_order_serial_line_fk foreign key (order_line_id, org_id)
    references public.assembly_order_line (id, org_id) on delete restrict
);
-- Two partial uniques rather than one over a nullable column: in a plain unique
-- constraint two NULLs never collide, so the parent's serials would not be
-- protected against duplication at all.
create unique index assembly_order_serial_parent_uq
  on public.assembly_order_serial (order_id, serial_no) where order_line_id is null;
create unique index assembly_order_serial_line_uq
  on public.assembly_order_serial (order_line_id, serial_no) where order_line_id is not null;
create index assembly_order_serial_order_idx on public.assembly_order_serial (org_id, order_id);

alter table public.assembly_order_serial enable row level security;
create policy assembly_order_serial_select on public.assembly_order_serial
  for select to app_user using (org_id = (select app.current_org_id()));
create policy assembly_order_serial_insert on public.assembly_order_serial
  for insert to app_user with check (org_id = (select app.current_org_id()));
grant select, insert on public.assembly_order_serial to app_user;

grant update (output_lot_code, output_manufactured_on, output_expiry_date)
  on public.assembly_order to app_user;
grant update (output_lot_code) on public.assembly_order_line to app_user;

-- ── 3. A recipe in force is not editable ────────────────────────────────────
/*
 * 0089 said a bill of material is "a new version and the old one is archived,
 * never edited", and then granted UPDATE on output_qty, qty_per and scrap_pct
 * with nothing to stop an active recipe being changed under everything built
 * from it. The claim was true of the service and false of the database.
 */
create function app.bom_is_frozen_once_active()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  st text;
  target uuid;
  target_org uuid;
begin
  if tg_table_name = 'bom' then
    -- Status changes are the lifecycle itself; the recipe's CONTENT is what freezes.
    if old.status = 'draft' then
      return new;
    end if;
    if new.output_qty is distinct from old.output_qty
       or new.unit_id is distinct from old.unit_id
       or new.item_id is distinct from old.item_id then
      raise exception
        'a % bill of material cannot be changed; create a new version', old.status
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  -- On DELETE there is no NEW row at all, so the recipe being protected has to
  -- be read from OLD. Referencing NEW here would raise a confusing internal
  -- error instead of the refusal the caller needs to see.
  if tg_op = 'DELETE' then
    target := old.bom_id;
    target_org := old.org_id;
  else
    target := new.bom_id;
    target_org := new.org_id;
  end if;

  select b.status into st from public.bom b
  where b.id = target and b.org_id = target_org;
  if st is distinct from 'draft' then
    raise exception 'a % bill of material cannot be changed; create a new version',
      coalesce(st, 'missing')
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.bom_is_frozen_once_active() from public;

create trigger bom_frozen_once_active
  before update on public.bom
  for each row execute function app.bom_is_frozen_once_active();
create trigger bom_line_frozen_once_active
  before update or delete on public.bom_line
  for each row execute function app.bom_is_frozen_once_active();

-- ── 4. A movement may only name ITS OWN item's batches and units ────────────
/*
 * 0088 checked that the named quantities added up and never checked whose they
 * were. The composite foreign keys tie a detail row to the organization, not to
 * the item, so a movement of paint could name a batch of steel and the totals
 * would balance perfectly while the batch history of both items became fiction.
 */
create or replace function app.stock_movement_tracking_is_complete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  trk text;
  named numeric;
  units integer;
  strays integer;
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
    select count(*) into strays
    from public.stock_movement_lot ml
    join public.stock_lot sl on sl.id = ml.lot_id and sl.org_id = ml.org_id
    where ml.movement_id = new.id and ml.org_id = new.org_id
      and sl.item_id <> new.item_id;
    if strays > 0 then
      raise exception
        'movement % names % batch(es) belonging to a different item', new.id, strays
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
  select count(*) into strays
  from public.stock_movement_serial ms
  join public.stock_serial ss on ss.id = ms.serial_id and ss.org_id = ms.org_id
  where ms.movement_id = new.id and ms.org_id = new.org_id
    and ss.item_id <> new.item_id;
  if strays > 0 then
    raise exception
      'movement % names % unit(s) belonging to a different item', new.id, strays
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

/*
 * Detail cannot be added to a movement that has already been posted.
 *
 * The completeness check fires when a MOVEMENT is inserted. A detail row
 * inserted afterwards, in a later transaction, is never checked by it — so
 * without this an app_user holding the INSERT grant could append a lot line to
 * last month's movement and silently restate a batch's history.
 */
create function app.stock_tracking_detail_is_same_transaction()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  born timestamptz;
begin
  select m.created_at into born from public.stock_movement m
  where m.id = new.movement_id and m.org_id = new.org_id;
  if born is null then
    raise exception 'no such movement in this organization' using errcode = 'foreign_key_violation';
  end if;
  -- now() is the transaction's start time, so a movement created in THIS
  -- transaction has created_at = now() and an older one is strictly before it.
  if born < now() then
    raise exception
      'movement % was already posted; its lots and units cannot be changed afterwards',
      new.movement_id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
revoke all on function app.stock_tracking_detail_is_same_transaction() from public;

create trigger stock_movement_lot_same_transaction
  before insert on public.stock_movement_lot
  for each row execute function app.stock_tracking_detail_is_same_transaction();
create trigger stock_movement_serial_same_transaction
  before insert on public.stock_movement_serial
  for each row execute function app.stock_tracking_detail_is_same_transaction();

-- ── 5. A layer holds a VALUE, not just a rate ───────────────────────────────
/*
 * Cost conservation, fixed where it breaks.
 *
 * A layer used to hold only a unit cost, so every draw cost round(unit x qty)
 * and the residues never came back to anything. Consume 3 of a layer of 7 that
 * cost 1000 in total: at 143 a unit that is 429, then 572 for the rest, and 1
 * has vanished. The same rounding runs again when an assembly divides component
 * cost across units made, and again when a disassembly splits it back — the
 * audit found it in three places, which is three symptoms of one cause.
 *
 * Holding the remaining VALUE alongside the remaining quantity makes the last
 * draw take exactly what is left. Nothing is created and nothing evaporates,
 * whatever the quantities divide into.
 */
alter table public.stock_cost_layer
  add column value_remaining_minor bigint;

update public.stock_cost_layer
set value_remaining_minor = round(unit_cost_minor * qty_remaining);

alter table public.stock_cost_layer
  alter column value_remaining_minor set not null,
  add constraint stock_cost_layer_value_ck check (value_remaining_minor >= 0),
  /*
   * Value cannot outlive the goods it belongs to.
   *
   * Stated one way only, deliberately. The reverse — quantity with no value
   * left — is legitimate in two ordinary cases: goods received free, and a
   * layer so cheap relative to its quantity that a proportional draw rounds the
   * last fils away. Insisting the two run out together would refuse both.
   */
  add constraint stock_cost_layer_value_qty_ck
    check (qty_remaining > 0 or value_remaining_minor = 0);

grant update (qty_remaining, value_remaining_minor, depleted_at)
  on public.stock_cost_layer to app_user;

-- ── 9. A layer that says nothing about its value is worth rate x quantity ────
/*
 * The same lesson as accepted_qty in 0087, learned again: adding a NOT NULL
 * column breaks every writer that predates it, and "every writer" always turns
 * out to include one nobody remembered.
 *
 * Filling it here rather than in each caller means a seed script, a fixture or
 * an older code path records the same fact the posting path does. It is not a
 * guess: at the moment a layer is created, rate x quantity IS its value — the
 * two only diverge later, as draws take rounded shares out of it.
 */
create function app.stock_cost_layer_value_default()
returns trigger
language plpgsql
as $$
begin
  if new.value_remaining_minor is null then
    new.value_remaining_minor := round(coalesce(new.unit_cost_minor, 0) * coalesce(new.qty_remaining, 0));
  end if;
  return new;
end;
$$;
revoke all on function app.stock_cost_layer_value_default() from public;

create trigger stock_cost_layer_value_default
  before insert on public.stock_cost_layer
  for each row execute function app.stock_cost_layer_value_default();

comment on column public.stock_cost_layer.value_remaining_minor is
  'What is left to charge out of this layer, in base-currency minor units. The last draw takes all of it, so rounding never creates or destroys value.';

-- ── 6. A unit can come back ─────────────────────────────────────────────────
/*
 * 0088 said "one layer per serial: a unit is received once", which is false. A
 * unit that was issued and later returned, or bought back, is received again —
 * and the second receipt is a second cost, at whatever it cost the second time.
 *
 * What must never happen is two OPEN layers for one unit, because then issuing
 * it once would draw only part of its cost. That is the real invariant.
 */
drop index if exists public.stock_cost_layer_serial_uq;
create unique index stock_cost_layer_serial_open_uq
  on public.stock_cost_layer (org_id, serial_id)
  where serial_id is not null and qty_remaining > 0;

comment on index public.stock_cost_layer_serial_open_uq is
  'At most one OPEN layer per serialised unit. A unit received, issued and received again has two layers, only one of them open.';

-- ── 7. Saying which money a layer's numbers are in ──────────────────────────
/*
 * `unit_cost_minor` on a cost layer is BASE currency; `currency` describes
 * `original_unit_cost_minor`, the price the supplier actually charged.
 *
 * The two sit next to each other with no label, so a layer from a dollar
 * purchase reads as unit_cost_minor = <dirhams>, currency = 'USD' — which is a
 * true pair of facts arranged to look like one false one. Nothing computes from
 * it wrongly today; this is here so nothing starts to.
 */
comment on column public.stock_cost_layer.unit_cost_minor is
  'Base-currency unit cost, frozen at receipt. NOT in `currency` — see that column.';
comment on column public.stock_cost_layer.currency is
  'The currency of original_unit_cost_minor, i.e. what the supplier charged. The layer''s own unit_cost_minor and value_remaining_minor are always in the organization base currency.';

-- ── 8. What a draw actually took, to the minor unit ─────────────────────────
/*
 * stock_layer_consumption recorded a RATE — quantity and a unit cost — which is
 * enough to explain a draw and not enough to undo one.
 *
 * A reversal has to put back exactly what was taken. Rebuilding the amount as
 * unit_cost x qty rounds a second time, so reversing a draw of 225 across 2
 * units credits 113 x 2 = 226 and invents a minor unit. Every reversal did this,
 * which is the same rounding leak 0090 removed from the drawing side, surviving
 * on the returning side.
 */
alter table public.stock_layer_consumption
  add column value_minor bigint;

/*
 * The backfill has to step past the append-only trigger on this table.
 *
 * That trigger is right and stays: a posted draw is not editable by anyone.
 * A migration adding a column to rows that already exist is the one case it
 * cannot mean, and session_replication_role is the documented way to say so —
 * scoped to this statement, then put straight back.
 */
set local session_replication_role = replica;
update public.stock_layer_consumption
set value_minor = round(unit_cost_minor * qty);
set local session_replication_role = origin;

alter table public.stock_layer_consumption
  alter column value_minor set not null,
  add constraint stock_layer_consumption_value_ck check (value_minor >= 0);

/*
 * And the same for a draw's recorded amount.
 *
 * A row that states a rate and a quantity but no amount means the obvious thing:
 * the amount is the two multiplied. Only the posting path knows better — it has
 * the exact figure the layer gave up — so it passes one and everything else is
 * filled in here.
 */
create function app.stock_layer_consumption_value_default()
returns trigger
language plpgsql
as $$
begin
  if new.value_minor is null then
    new.value_minor := round(coalesce(new.unit_cost_minor, 0) * coalesce(new.qty, 0));
  end if;
  return new;
end;
$$;
revoke all on function app.stock_layer_consumption_value_default() from public;

create trigger stock_layer_consumption_value_default
  before insert on public.stock_layer_consumption
  for each row execute function app.stock_layer_consumption_value_default();

comment on column public.stock_layer_consumption.value_minor is
  'The exact base-currency amount this draw took from the layer. unit_cost_minor is the rate it worked out to and is for reading, not for arithmetic.';
