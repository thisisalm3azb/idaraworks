-- 0092_h22e_asset_corrections (H22E, part 2)
--
-- Two things 0091 claimed and did not do.
--
-- It called the custody trail append-only and enforced that by withholding an
-- UPDATE grant. H22B already learned that this is not enough — its own comment
-- says "withholding the grant stops app_user; it does not stop the table owner"
-- — and added triggers. H22E copied the prose and not the trigger, so the
-- history the whole register rests on was editable by any privileged connection,
-- and the test asserting otherwise passed against nothing.
--
-- It also treated a DRAFT disposal as a live one. The approval engine parks a
-- withdrawn request back at 'draft', and nothing could resubmit or cancel it —
-- so withdrawing a disposal made the asset permanently undisposable, with each
-- retry burning a reference number against a unique violation.

-- ── 1. History is history ───────────────────────────────────────────────────
/*
 * Append-only for EVERY role, including the one that owns the table.
 *
 * These three tables are the answers to questions an editable field cannot
 * answer: who held the drill in March, what the inspector found before the
 * accident, when the machine was last serviced. A row that can be quietly
 * changed afterwards answers none of them.
 */
create function app.asset_history_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'asset history is append-only: a recorded % cannot be % (record a correcting event instead)',
    tg_table_name, lower(tg_op)
    using errcode = 'restrict_violation';
end;
$$;

create trigger asset_assignment_no_update
  before update or delete on public.asset_assignment
  for each row execute function app.asset_history_is_append_only();
create trigger asset_inspection_no_update
  before update or delete on public.asset_inspection
  for each row execute function app.asset_history_is_append_only();
create trigger asset_maintenance_event_no_update
  before update or delete on public.asset_maintenance_event
  for each row execute function app.asset_history_is_append_only();

comment on table public.asset_assignment is
  'Append-only for every role including the table owner. A mistake is corrected by a further event naming the original, never by an edit.';

-- ── 2. A draft disposal blocks nothing ──────────────────────────────────────
/*
 * "One live request per asset" must mean SUBMITTED or APPROVED.
 *
 * A draft is a request that has been withdrawn or not yet put — it holds no
 * claim on the asset, and treating it as live meant a single withdrawal locked
 * the asset out of disposal forever, because nothing could resubmit or cancel
 * the parked row.
 */
drop index if exists public.asset_disposal_open_uq;
create unique index asset_disposal_open_uq on public.asset_disposal (org_id, asset_id)
  where status in ('submitted', 'approved');

/*
 * A withdrawn request can be put again, or abandoned.
 *
 * 'cancelled' was already in the status vocabulary with no way to reach it,
 * which is the same defect in a different shape: a state nothing can enter is
 * not a state, it is a comment.
 */
comment on column public.asset_disposal.status is
  'draft = withdrawn or not yet submitted, and holds no claim on the asset. submitted/approved are live. completed/rejected/cancelled are final.';
