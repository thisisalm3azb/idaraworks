-- 0142 — pin job.customer_id to the job's own organisation.
--
-- Security review, 2026-09-20. Every other tenant link in the schema is a
-- composite foreign key (<x>_id, org_id) → (id, org_id), so the database
-- itself refuses a record from another company. job.customer_id (0022) was
-- the one single-column exception: a member could store another company's
-- customer id on a job. Reads join back with an org filter, so nothing was
-- displayed, but the link was stored and survived into costing and
-- invoicing joins. The service now checks the customer in-transaction; this
-- is the backstop that does not depend on any call site remembering to.
--
-- Additive and safe: verified zero cross-organisation rows on the TEST and
-- production databases before writing this file. customer (id, org_id) is
-- already unique (the payment/quote/invoice composite keys reference it).

alter table public.job
  add constraint job_customer_org_fk
  foreign key (customer_id, org_id) references public.customer (id, org_id);

comment on constraint job_customer_org_fk on public.job is
  'A job''s customer must belong to the job''s organisation (composite tenant pin, 0142).';
