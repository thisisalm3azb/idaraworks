-- 0037_s4_concurrency_guards (S4 review fixes — concurrency invariants AT THE DB).
-- The single-request flows are correct, but under CONCURRENT access the service
-- guards were insufficient (review): two submits could open two pending approvals
-- for one subject (and a later reject of the duplicate would revert an approved
-- subject), and two converts could mint two approved POs from one MR. Enforce the
-- invariants at the database so no code path can violate them. Forward-only.

-- ONE live (pending) approval per subject. A second concurrent submitForApproval
-- insert now fails with 23505; the service maps it to a typed "already submitted".
-- Historical approvals (approved/rejected/withdrawn/superseded) are unconstrained,
-- so re-submission after a rejection still works.
create unique index approval_one_live_per_subject
  on public.approval (org_id, subject_type, subject_id)
  where state = 'pending';

-- At most ONE purchase_order per source material_request — a second concurrent
-- convertMrToPo (lost update) cannot mint a duplicate approved PO.
create unique index purchase_order_one_per_mr
  on public.purchase_order (org_id, mr_id)
  where mr_id is not null;
