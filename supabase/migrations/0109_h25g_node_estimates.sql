-- 0109 — H25G: draft plan elements carry their own scheduling semantics.
--
-- A linked task already has three-point estimates, constraints and a deadline
-- on the canonical task row (0107). A DRAFT element (a milestone, phase or
-- task that is not yet a record) had nowhere to keep them, so a plan made of
-- drafts could never be simulated or constrained. Additive: new nullable
-- columns, same CHECKs as the task, UPDATE grant widened. No data changes.

alter table public.studio_node
  add column constraint_kind text not null default 'none'
    check (constraint_kind in ('none', 'start_no_earlier', 'finish_no_later')),
  add column constraint_date date,
  add column deadline_date date,
  add column estimate_optimistic_days numeric(7, 2)
    check (estimate_optimistic_days is null or estimate_optimistic_days >= 0),
  add column estimate_pessimistic_days numeric(7, 2)
    check (estimate_pessimistic_days is null or estimate_pessimistic_days >= 0),
  add constraint studio_node_constraint_date_ck
    check ((constraint_kind = 'none') = (constraint_date is null));

grant update (constraint_kind, constraint_date, deadline_date,
              estimate_optimistic_days, estimate_pessimistic_days)
  on public.studio_node to app_user;
