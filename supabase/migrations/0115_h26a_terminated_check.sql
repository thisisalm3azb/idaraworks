-- 0115_h26a_terminated_check (H26 — a terminated document may later be
-- archived; the termination stamp stays as history).
--
-- 0114 declared (status = 'terminated') = (terminated_at is not null), which
-- refuses the legal transition terminated → archived because the stamp is
-- kept. The rule is one-directional: a terminated status always carries its
-- stamp; a stamp never forces the status. 0114 is already recorded on the
-- test project, so the repair is a new file (never edit an applied migration).
alter table public.doc_document drop constraint doc_document_terminated_ck;
alter table public.doc_document
  add constraint doc_document_terminated_ck
  check (status <> 'terminated' or terminated_at is not null);
