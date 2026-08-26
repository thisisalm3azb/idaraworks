-- 0074_document_profile — Universal organization document profile (003B.1).
--
-- The owner's 2026-08-27 amendment (phase2/14 §4; audit §12): every formal
-- document carries the organization's actual identity as a CORE capability.
-- `company` (the default row every org receives at signup — 0003/0068
-- app.create_org_with_owner) becomes the canonical LEGAL issuer: it already
-- owns tax_reg_no (the only TRN source in the schema — org_branding never had
-- one); this migration adds the missing structured legal/contact/address/
-- document fields. `org_branding` (0071) remains the canonical VISUAL source
-- (logo pointer, accent, trading display name, footer). Document-profile
-- reads compose the two (src/modules/branding/service.ts).
--
-- legal-name compatibility resolution (two names must never silently drift):
--   company.legal_name (new, canonical writer)
--     → org_branding.legal_name (FROZEN legacy fallback — its last writer is
--       removed in the same release; the column is kept for legacy reads)
--     → company.name (the signup-seeded workspace-name copy).
--
-- Append-only; no destructive backfill (existing rows keep nulls and resolve
-- through the fallback chain); tenant isolation via the existing 0001 RLS
-- policy + table-level select/insert/update grants (no DELETE grant exists —
-- no-hard-delete law). All new columns are nullable with length-bounded
-- CHECKs; document language is constrained to the three supported modes.

alter table public.company
  add column legal_name text
    check (legal_name is null or length(legal_name) between 1 and 200),
  add column trade_license_no text
    check (trade_license_no is null or length(trade_license_no) between 1 and 100),
  add column address_en text
    check (address_en is null or length(address_en) between 1 and 400),
  add column address_ar text
    check (address_ar is null or length(address_ar) between 1 and 400),
  add column city text
    check (city is null or length(city) between 1 and 120),
  add column region text
    check (region is null or length(region) between 1 and 120),
  add column postal_code text
    check (postal_code is null or length(postal_code) between 1 and 20),
  add column country text
    check (country is null or length(country) between 1 and 120),
  add column phone text
    check (phone is null or length(phone) between 1 and 50),
  add column email text
    check (email is null or length(email) between 3 and 254),
  add column website text
    check (website is null or length(website) between 1 and 200),
  add column signatory_name text
    check (signatory_name is null or length(signatory_name) between 1 and 160),
  add column signatory_title text
    check (signatory_title is null or length(signatory_title) between 1 and 160),
  add column payment_instructions text
    check (payment_instructions is null or length(payment_instructions) <= 1000),
  add column doc_language text not null default 'bilingual'
    check (doc_language in ('en', 'ar', 'bilingual'));

-- Exactly one default (issuer) company per org. Signup inserts exactly one
-- default row and no other writer exists, so this is safe on existing data;
-- it hard-guarantees the document profile's "the default company" read.
create unique index company_default_uq
  on public.company (org_id)
  where is_default;
