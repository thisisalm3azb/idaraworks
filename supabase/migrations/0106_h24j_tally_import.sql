-- H24J — Tally migration batches.
--
-- One row per uploaded file. The file's SHA-256 makes re-uploads idempotent
-- (same bytes = same batch), the account map and every report are stored on
-- the batch, and the journal entries an approved batch creates carry
-- source ('tally_import', batch id, 'voucher:<key>') so the ledger's own
-- one-event-once index makes re-approval a no-op. History is never invented:
-- vouchers dated before the books start are EXCEPTIONS, not postings.

create table public.tally_import (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  filename text not null check (length(filename) between 1 and 260),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  format text not null check (format in ('tally_xml_masters', 'tally_xml_vouchers', 'csv')),
  status text not null default 'inspected'
    check (status in ('inspected', 'validated', 'imported', 'failed')),
  -- Parsed summary: ledger names, voucher counts, date range, totals.
  payload jsonb not null default '{}',
  -- Human-approved ledger-name -> gl_account mapping (or 'skip').
  account_map jsonb not null default '{}',
  -- Dry-run and import reports: per-account totals, exceptions, counts.
  report jsonb not null default '{}',
  created_by uuid not null references public.user_profile (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tally_import_id_org_uq unique (id, org_id),
  constraint tally_import_file_uq unique (org_id, file_sha256)
);
create index tally_import_org_idx on public.tally_import (org_id, created_at desc);
alter table public.tally_import enable row level security;
create policy tally_import_all on public.tally_import
  for all to app_user
  using (org_id = (select app.current_org_id()))
  with check (org_id = (select app.current_org_id()));
grant select, insert on public.tally_import to app_user;
grant update (status, account_map, report, updated_at) on public.tally_import to app_user;
