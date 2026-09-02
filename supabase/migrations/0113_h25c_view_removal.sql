-- 0113 — H25C: saved views can be retired.
--
-- studio_view (0107) has no DELETE grant by house law and no soft-removal
-- column, so a saved view could never be taken out of the list. Additive:
-- a removed_at stamp, indexed for the live list, in the UPDATE grant.

alter table public.studio_view add column removed_at timestamptz;
create index studio_view_live_idx on public.studio_view (org_id, plan_id) where removed_at is null;
grant update (removed_at) on public.studio_view to app_user;
