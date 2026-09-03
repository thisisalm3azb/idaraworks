-- ═══════════════════════════════════════════════════════════════════════════
-- H29E — the shipped country-pack versions, as rows.
--
-- 0130 created `country_pack` and everything that depends on it: the exclusion
-- constraint that stops two resolvable versions covering one day, the review
-- records, and the foreign key every adoption carries. It created no rows, so
-- adopting a version failed against the foreign key — the registry lived only
-- in TypeScript and the database had never heard of it.
--
-- The registry in `src/platform/country/packs/` stays the source of truth for
-- what a version CONTAINS: rates, address shapes, identifier patterns, module
-- references. This table carries only what the database itself has to reason
-- about — which versions exist, which country each belongs to, and the window
-- each one applies to — so the validity windows can be enforced by a constraint
-- instead of by hope, and so an adoption can point at something real.
--
-- Adding a pack version is therefore a two-part release: the registry entry and
-- a migration adding its row. `tests/integration/h29a-establishments.test.ts`
-- asserts the two agree, so forgetting the second half fails CI rather than
-- failing a customer's adoption.
-- ═══════════════════════════════════════════════════════════════════════════

insert into public.country_pack (
  pack_key, country, jurisdiction, version, status,
  effective_from, effective_to, supersedes, owner,
  supported_languages, currency, default_timezone,
  sources, known_limitations, change_history
) values
  (
    'AE-2026-09-03', 'AE', 'United Arab Emirates (federal)', '2026-09-03', 'active',
    date '2026-09-03', null, null, 'platform',
    '["en","ar"]'::jsonb, 'AED', 'Asia/Dubai',
    '["docs/H29-EVIDENCE-LOG.md part E (UAE electronic invoicing)","docs/H29-EVIDENCE-LOG.md part F (standards)","H23 and H24 evidence logs (UAE VAT, corporate tax, payroll)"]'::jsonb,
    '["No phase date for UAE electronic invoicing is encoded, because none could be read from an official text.","Electronic invoicing needs an Accredited Service Provider, which the organisation must appoint. The channel ships disabled.","No tax or labour professional has reviewed this pack.","Nothing here files a return, submits an invoice or gives tax advice."]'::jsonb,
    '["2026-09-03: first version, assembled from the H23 and H24 evidence logs."]'::jsonb
  ),
  (
    'SA-2026-09-03', 'SA', 'Kingdom of Saudi Arabia', '2026-09-03', 'approved',
    date '2026-09-03', null, null, 'platform',
    '["ar","en"]'::jsonb, 'SAR', 'Asia/Riyadh',
    '["docs/H29-EVIDENCE-LOG.md part A (Saudi VAT)","docs/H29-EVIDENCE-LOG.md part B (ZATCA electronic invoicing)","docs/H29-EVIDENCE-LOG.md part C (Saudi employment and GOSI)","docs/H29-EVIDENCE-LOG.md part D (national address and PDPL)"]'::jsonb,
    '["No ZATCA credential exists, so no invoice can be submitted, cleared or reported. The adapter is contract-tested against the published standards with deterministic fixtures.","Cryptographic stamping needs a certificate issued through ZATCA onboarding. The stamping seam refuses without one.","The GOSI contributory-wage ceiling, the 2024 pension transition and the end-of-service wage base are configuration, not product defaults.","No Saudi tax, labour or data-protection professional has reviewed this pack.","Nothing here files a return, submits an invoice or gives advice."]'::jsonb,
    '["2026-09-03: first version, from ZATCA, MHRSD, GOSI, National Address and SDAIA sources."]'::jsonb
  )
on conflict (pack_key) do nothing;

-- The review state each version is genuinely in. Recorded, not assumed: the
-- readiness centre reads these, and a state nobody set must read as
-- "not started" rather than as an absent row nobody notices.
insert into public.country_pack_review (pack_key, kind, state, reviewer, note) values
  ('AE-2026-09-03', 'internal', 'passed', 'H29 build',
   'Assembled and cross-checked against the H23/H24 evidence logs during H29.'),
  ('AE-2026-09-03', 'professional', 'not_started', null,
   'No tax or labour professional has reviewed this pack.'),
  ('AE-2026-09-03', 'provider', 'not_started', null,
   'No Accredited Service Provider is appointed, so no electronic-invoicing channel can operate.'),
  ('SA-2026-09-03', 'internal', 'passed', 'H29 build',
   'Assembled from primary sources and recorded in docs/H29-EVIDENCE-LOG.md during H29.'),
  ('SA-2026-09-03', 'professional', 'not_started', null,
   'No Saudi tax, labour or data-protection professional has reviewed this pack.'),
  ('SA-2026-09-03', 'provider', 'not_started', null,
   'No ZATCA onboarding has taken place and no credential exists.')
on conflict (pack_key, kind) do nothing;
