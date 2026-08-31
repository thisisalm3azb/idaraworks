-- 0087_h22c1_currency_disposition (H22C.1)
--
-- Three gaps H22C left open, closed rather than deferred:
--   1. purchase orders in a foreign currency, with an audited rate
--   2. receipt disposition — accepted, damaged, quarantined, rejected
--   3. supplier returns that reverse the right quantity and the right cost
--
-- Additive throughout. Existing orders are interpreted explicitly as
-- base-currency documents rather than being given an invented currency.

-- ── 1. Multi-currency purchasing ────────────────────────────────────────────
/*
 * A purchase order states its own currency and the rate used to express it in
 * the organization's money.
 *
 * base_currency is stored on the ORDER, not read from the org at display time.
 * An organization can change its base currency; a document that already exists
 * must keep saying what it said. The same reasoning as the issuer snapshot.
 *
 * There is no external rate service and none is required. A rate is either
 * trivially 1 because the currencies match, or it is entered by an authenticated
 * person and audited as a mutation like any other.
 */
alter table public.purchase_order
  add column currency char(3),
  add column base_currency char(3),
  add column exchange_rate numeric(18, 8),
  add column rate_date date,
  /*
   * Where the number came from. 'same_currency' is the trivial case;
   * 'manual' means a person typed it and the audit log names them;
   * 'legacy_base' marks orders that predate this column and were interpreted,
   * not converted — see the backfill below.
   */
  add column rate_source text,
  add column base_total_minor bigint;

/*
 * Interpret existing orders, do not convert them.
 *
 * Every order written before this migration was implicitly in the
 * organization's base currency, because nothing else was possible: there was no
 * currency column and no rate. Recording that reading explicitly is honest.
 * Assigning them a foreign currency would be inventing history.
 *
 * rate_source = 'legacy_base' keeps them distinguishable from orders a person
 * actually confirmed, so a later review can tell the two apart.
 */
update public.purchase_order po
set currency = o.base_currency,
    base_currency = o.base_currency,
    exchange_rate = 1,
    rate_date = po.created_at::date,
    rate_source = 'legacy_base',
    base_total_minor = po.total_minor
from public.org o
where o.id = po.org_id;

alter table public.purchase_order
  alter column currency set not null,
  alter column base_currency set not null,
  alter column exchange_rate set not null,
  alter column rate_source set not null,
  alter column base_total_minor set not null;

alter table public.purchase_order
  add constraint purchase_order_currency_ck
    check (currency in ('AED','SAR','QAR','KWD','BHD','OMR','USD','EUR')),
  add constraint purchase_order_base_currency_ck
    check (base_currency in ('AED','SAR','QAR','KWD','BHD','OMR','USD','EUR')),
  add constraint purchase_order_rate_source_ck
    check (rate_source in ('same_currency', 'manual', 'legacy_base')),
  /*
   * The rule that stops the silent-default bug: a rate of exactly 1 is only
   * meaningful when the two currencies are the same. A foreign-currency order
   * must carry a real, positive, non-trivial rate, so "we forgot to set it"
   * cannot masquerade as "the rate happens to be one".
   */
  add constraint purchase_order_rate_ck check (
    (currency = base_currency and exchange_rate = 1)
    or (currency <> base_currency and exchange_rate > 0 and exchange_rate <> 1)
  ),
  -- A legacy interpretation is only ever a same-currency reading.
  add constraint purchase_order_legacy_same_ck
    check (rate_source <> 'legacy_base' or currency = base_currency);

grant update (currency, base_currency, exchange_rate, rate_date, rate_source, base_total_minor)
  on public.purchase_order to app_user;

/*
 * Freeze the money on an issued order.
 *
 * Once an order leaves the building, its currency and rate are part of what the
 * supplier was told. Changing either afterwards would silently restate a
 * commitment; a change of terms is a revision, which creates a new document.
 */
create function app.purchase_order_money_is_frozen()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'draft' then
    return new;
  end if;
  if new.currency is distinct from old.currency
     or new.exchange_rate is distinct from old.exchange_rate
     or new.base_currency is distinct from old.base_currency then
    raise exception
      'the currency and exchange rate of a % purchase order cannot change; issue a revision',
      old.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

/*
 * Fill in the money a caller did not state — and only when there is nothing to
 * convert.
 *
 * An order written without a currency is a base-currency order: that is what it
 * has always meant, and saying so explicitly is honest. But a rate is NEVER
 * assumed for a foreign currency. If the currency differs from the base and no
 * rate was given, exchange_rate stays null and the NOT NULL constraint refuses
 * the insert, so "we forgot the rate" fails loudly instead of booking at one.
 */
create function app.purchase_order_money_defaults()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  org_base char(3);
begin
  if new.base_currency is null then
    select o.base_currency into org_base from public.org o where o.id = new.org_id;
    new.base_currency := org_base;
  end if;
  if new.currency is null then
    new.currency := new.base_currency;
  end if;
  if new.exchange_rate is null and new.currency = new.base_currency then
    new.exchange_rate := 1;
  end if;
  if new.rate_source is null then
    new.rate_source := case
      when new.currency = new.base_currency then 'same_currency'
      else 'manual'
    end;
  end if;
  if new.rate_date is null then
    new.rate_date := current_date;
  end if;
  /*
   * Only the trivial conversion is filled in here.
   *
   * Converting a foreign total needs the minor-unit exponent of BOTH currencies
   * — 100 fils is not 100 cents — and that table lives in the application
   * registry, not in the database. So a foreign order must state its own base
   * total; leaving it null lets the NOT NULL constraint refuse the insert rather
   * than book a number that is out by a factor of ten.
   */
  if new.base_total_minor is null and new.currency = new.base_currency then
    new.base_total_minor := coalesce(new.total_minor, 0);
  end if;
  return new;
end;
$$;
revoke all on function app.purchase_order_money_defaults() from public;

create trigger purchase_order_money_defaults
  before insert on public.purchase_order
  for each row execute function app.purchase_order_money_defaults();

create trigger purchase_order_freeze_money
  before update on public.purchase_order
  for each row execute function app.purchase_order_money_is_frozen();

comment on column public.purchase_order.rate_source is
  'same_currency (trivially 1), manual (a person entered it, audited), or legacy_base (written before 0087 and interpreted as base currency, never converted).';

-- ── 2. Receipt disposition ──────────────────────────────────────────────────
/*
 * What actually happened to what arrived.
 *
 * received_qty is everything that turned up. It splits four ways, and the four
 * go to different places:
 *
 *   accepted     — good stock, into a storage location, available to issue
 *   damaged      — owned but unusable, into a damaged location, NOT available
 *   quarantined  — awaiting inspection, into a quarantine location, NOT available
 *   rejected     — refused at the door. Never owned, so never in the ledger.
 *
 * accepted is stored rather than derived so a receipt can record a deliberate
 * split, and a constraint keeps the four adding up to what arrived.
 */
alter table public.goods_receipt_line
  add column accepted_qty numeric(14, 3),
  add column quarantine_qty numeric(14, 3) not null default 0
    check (quarantine_qty >= 0),
  add column returned_qty numeric(14, 3) not null default 0
    check (returned_qty >= 0);

-- Existing lines: everything not damaged or rejected was accepted, which is
-- exactly what H22C already assumed when it posted them.
update public.goods_receipt_line
set accepted_qty = greatest(received_qty - damaged_qty - rejected_qty, 0);

alter table public.goods_receipt_line
  alter column accepted_qty set not null,
  add constraint goods_receipt_line_accepted_ck check (accepted_qty >= 0),
  -- The four dispositions must account for exactly what arrived.
  add constraint goods_receipt_line_disposition_ck
    check (accepted_qty + damaged_qty + rejected_qty + quarantine_qty = received_qty),
  -- Only what was accepted or damaged is owned, so only that can be returned.
  add constraint goods_receipt_line_returned_ck
    check (returned_qty <= accepted_qty + damaged_qty + quarantine_qty);

/*
 * A receipt line that says nothing about disposition accepted everything it did
 * not otherwise account for.
 *
 * That is the honest reading, and it is what every line written before this
 * migration meant. Filling it here rather than in each writer means an older
 * caller — a seed script, a simulation, an integration that predates the split —
 * records the same fact as the receiving screen instead of failing on a column
 * it has never heard of. The CHECK above still refuses a split that does not add
 * up, so this fills a gap without hiding a contradiction.
 */
create function app.goods_receipt_line_accepted_default()
returns trigger
language plpgsql
as $$
begin
  if new.accepted_qty is null then
    new.accepted_qty := coalesce(new.received_qty, 0)
      - coalesce(new.damaged_qty, 0)
      - coalesce(new.rejected_qty, 0)
      - coalesce(new.quarantine_qty, 0);
  end if;
  return new;
end;
$$;
revoke all on function app.goods_receipt_line_accepted_default() from public;

create trigger goods_receipt_line_accepted_default
  before insert on public.goods_receipt_line
  for each row execute function app.goods_receipt_line_accepted_default();

grant update (accepted_qty, quarantine_qty, returned_qty)
  on public.goods_receipt_line to app_user;

/*
 * Receipt lines used to be insert-only, because nothing ever amended one.
 * Returns do: returned_qty is a running total kept on the line, and the return
 * path locks the line (select … for update) before checking eligibility.
 *
 * Both need an UPDATE policy. Without one, row-level security silently matches
 * no rows — the lock finds nothing and the increment updates nothing, with no
 * error either time. The narrow column grant above keeps this to the three
 * disposition counters; nothing else about a receipt line becomes editable.
 */
create policy grn_line_update on public.goods_receipt_line
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));

comment on column public.goods_receipt_line.rejected_qty is
  'Refused at the door. Never enters the ledger, because it was never owned.';

-- ── 3. Supplier returns ─────────────────────────────────────────────────────
/*
 * Sending goods back, traceably.
 *
 * A return names the RECEIPT LINE it reverses, so a partial return stays
 * connected to the delivery it came from and the eligible quantity can be
 * checked against what was actually received. The ledger movement consumes the
 * cost layer the receipt created, so the value leaving equals the value that
 * arrived rather than today's average.
 */
create table public.supplier_return (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  reference text not null,
  supplier_id uuid not null,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'cancelled')),
  reason text not null check (length(trim(reason)) between 1 and 500),
  notes text check (notes is null or length(notes) <= 2000),
  sent_at timestamptz,
  sent_by uuid references public.user_profile (id),
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_return_id_org_uq unique (id, org_id),
  constraint supplier_return_org_ref_uq unique (org_id, reference),
  constraint supplier_return_supplier_fk foreign key (supplier_id, org_id)
    references public.supplier (id, org_id) on delete restrict
);
create index supplier_return_org_idx on public.supplier_return (org_id, status, created_at desc);

create table public.supplier_return_line (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  return_id uuid not null,
  /** The delivery this is going back from. Every return traces to one. */
  goods_receipt_line_id uuid not null,
  item_id uuid not null,
  unit_id uuid not null,
  qty numeric(20, 6) not null check (qty > 0),
  /** Which disposition it is leaving from, so the right stock is reduced. */
  disposition text not null default 'accepted'
    check (disposition in ('accepted', 'damaged', 'quarantine')),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  constraint supplier_return_line_id_org_uq unique (id, org_id),
  constraint supplier_return_line_return_fk foreign key (return_id, org_id)
    references public.supplier_return (id, org_id) on delete restrict,
  constraint supplier_return_line_grl_fk foreign key (goods_receipt_line_id, org_id)
    references public.goods_receipt_line (id, org_id) on delete restrict,
  constraint supplier_return_line_item_fk foreign key (item_id, org_id)
    references public.item (id, org_id) on delete restrict,
  constraint supplier_return_line_unit_fk foreign key (unit_id, org_id)
    references public.unit_of_measure (id, org_id) on delete restrict,
  -- One line per receipt line per return: a second attempt to return the same
  -- delivery line within one document is a duplicate, not an addition.
  constraint supplier_return_line_once_uq unique (return_id, goods_receipt_line_id, disposition)
);
create index supplier_return_line_return_idx on public.supplier_return_line (org_id, return_id);
create index supplier_return_line_grl_idx
  on public.supplier_return_line (org_id, goods_receipt_line_id);

alter table public.supplier_return enable row level security;
create policy supplier_return_select on public.supplier_return
  for select to app_user using (org_id = (select app.current_org_id()));
create policy supplier_return_insert on public.supplier_return
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy supplier_return_update on public.supplier_return
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.supplier_return to app_user;
grant update (status, notes, sent_at, sent_by, updated_at) on public.supplier_return to app_user;

alter table public.supplier_return_line enable row level security;
create policy supplier_return_line_select on public.supplier_return_line
  for select to app_user using (org_id = (select app.current_org_id()));
create policy supplier_return_line_insert on public.supplier_return_line
  for insert to app_user with check (org_id = (select app.current_org_id()));
create policy supplier_return_line_update on public.supplier_return_line
  for update to app_user using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.supplier_return_line to app_user;
grant update (qty, sort) on public.supplier_return_line to app_user;

-- The ledger learns the new source type, together with the table that backs it.
alter table public.stock_movement drop constraint if exists stock_movement_source_type_check;
alter table public.stock_movement
  add constraint stock_movement_source_type_ck check (source_type in (
    'goods_receipt_line', 'report_material_line', 'stock_transfer',
    'stock_count_line', 'supplier_return_line', 'manual'
  ));

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
  elsif new.source_type = 'supplier_return_line' then
    select exists (select 1 from public.supplier_return_line x
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

-- ── 4. One business event, several places ───────────────────────────────────
/*
 * H22B indexed (source_type, source_id, movement_type) uniquely, on the
 * assumption that a business event produces exactly one movement. H22C.1 makes
 * that assumption false in two ordinary ways:
 *
 *   - a receipt line splits into accepted, damaged and quarantined quantities,
 *     and those go to three different locations
 *   - an issue draws from every bin it needs to cover the quantity
 *
 * Location is what tells those apart, so it joins the key.
 *
 * This does not weaken the protection. Posting the same event twice into the
 * same place is still refused here, and posting it twice at all is still refused
 * by the idempotency key — which is derived from the source event, and now names
 * the disposition or the bin as well.
 */
drop index if exists public.stock_movement_source_event_uq;
create unique index stock_movement_source_event_uq
  on public.stock_movement (org_id, source_type, source_id, movement_type, location_id)
  where source_id is not null;
