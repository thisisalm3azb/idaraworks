-- H27F — reviewed customer merge re-points every customer reference in one
-- transaction, which needs a column-scoped UPDATE grant on customer_id for
-- each referencing table (and counterparty_id on Document Studio documents).
-- Grants are additive and idempotent; no DELETE grant anywhere. Also widens
-- the guided-import kinds to the CRM records (contacts, leads, opportunities).
-- Additive only; no data change.

grant update (customer_id) on public.customer_contact to app_user;
grant update (customer_id) on public.customer_update to app_user;
grant update (customer_id) on public.quote to app_user;
grant update (customer_id) on public.invoice to app_user;
grant update (customer_id) on public.payment to app_user;
grant update (customer_id) on public.job to app_user;
grant update (customer_id) on public.opportunity to app_user;
grant update (customer_id) on public.sales_activity to app_user;
grant update (customer_id) on public.crm_consent to app_user;
grant update (customer_id) on public.crm_touch to app_user;
grant update (customer_id) on public.crm_customer_signal to app_user;
grant update (counterparty_id) on public.doc_document to app_user;

-- Automation runs record their outcome on the claimed row.
grant update (status, result, error) on public.crm_automation_run to app_user;

alter table public.import_batch drop constraint if exists import_batch_kind_check;
alter table public.import_batch
  add constraint import_batch_kind_check
  check (kind in ('customers', 'employees', 'items', 'contacts', 'leads', 'opportunities'));
