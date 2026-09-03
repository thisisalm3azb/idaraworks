-- ═══════════════════════════════════════════════════════════════════════════
-- H29C — translation governance: how each shipped language was PRODUCED and
-- what review it has actually had.
--
-- The mandate is specific: a machine-assisted translation must be marked for
-- native-human review before public general availability, and native review may
-- not be claimed unless evidence exists. Both halves of that need somewhere to
-- live, and neither belongs in code.
--
-- Completeness deliberately does NOT live here. It is measured from the
-- catalogues themselves (tests/unit/i18n.test.ts, the es.same.json record) and
-- shown alongside this row. A stored "98% complete" is a claim; a count taken
-- from the file is a fact, and the two can never disagree if only one exists.
--
-- This is platform state, not tenant state: it describes the product, is
-- identical for every organisation, and only a platform operator may write it.
-- Readable by any signed-in user because the interface tells people plainly
-- that a language is awaiting review.
-- ═══════════════════════════════════════════════════════════════════════════

create table public.locale_release (
  -- The locale key, matching SUPPORTED_LOCALES in src/platform/registries.ts.
  locale text primary key check (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),

  -- How the catalogue text was produced. Recorded by a person, never inferred:
  --   source           — the language the product is authored in
  --   machine_assisted — drafted with machine help, whatever the review since
  --   native_authored  — written by a native speaker of this language
  --   professional     — produced by a professional translation supplier
  production text not null
    check (production in ('source', 'machine_assisted', 'native_authored', 'professional')),

  -- Native-speaker review of the product copy. `not_applicable` is only honest
  -- for the source language.
  native_review text not null default 'not_started'
    check (native_review in ('not_applicable', 'not_started', 'in_progress', 'passed', 'failed')),
  native_reviewer text check (native_reviewer is null or length(native_reviewer) <= 200),
  native_reviewed_at timestamptz,

  -- Separate from native review on purpose: a fluent speaker confirming the
  -- copy reads naturally is a different question from a qualified person
  -- confirming that legally sensitive wording is right for a jurisdiction.
  -- Language is not jurisdiction (ADR-70), so this stays its own fact.
  legal_review text not null default 'not_applicable'
    check (legal_review in ('not_applicable', 'not_started', 'in_progress', 'passed', 'failed')),
  legal_reviewer text check (legal_reviewer is null or length(legal_reviewer) <= 200),
  legal_reviewed_at timestamptz,

  note text check (note is null or length(note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A reviewer and a date are meaningless without a decided state, and a
  -- decided state is unverifiable without them. The pair moves together.
  constraint locale_release_native_evidence check (
    (native_review in ('passed', 'failed')) = (native_reviewer is not null and native_reviewed_at is not null)
  ),
  constraint locale_release_legal_evidence check (
    (legal_review in ('passed', 'failed')) = (legal_reviewer is not null and legal_reviewed_at is not null)
  )
);

alter table public.locale_release enable row level security;
create policy locale_release_read on public.locale_release for select to app_user using (true);
grant select on public.locale_release to app_user;
create trigger locale_release_touch before update on public.locale_release
  for each row execute function app.set_updated_at();

comment on table public.locale_release is
  'H29C: how each shipped language was produced and what review it has had. Platform state; operator-write only. Completeness is measured from the catalogues, never stored here.';

-- ── the one write path ─────────────────────────────────────────────────────
-- Security definer + an explicit operator assertion, matching country_pack_review
-- (0130). No UPDATE or INSERT grant exists on the table itself, so this function
-- is the only way a row can change, and every change lands in platform_audit.
create or replace function app.locale_release_set(
  p_locale text,
  p_production text,
  p_native_review text,
  p_native_reviewer text,
  p_legal_review text,
  p_legal_reviewer text,
  p_note text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_native_at timestamptz := case when p_native_review in ('passed', 'failed') then now() end;
  v_legal_at timestamptz := case when p_legal_review in ('passed', 'failed') then now() end;
begin
  perform app.assert_platform_operator();

  -- A decided review without a named reviewer is exactly the unevidenced claim
  -- the mandate forbids, so it is refused here rather than stored and shown.
  if p_native_review in ('passed', 'failed')
     and (p_native_reviewer is null or length(trim(p_native_reviewer)) = 0) then
    raise exception 'native review needs a named reviewer';
  end if;
  if p_legal_review in ('passed', 'failed')
     and (p_legal_reviewer is null or length(trim(p_legal_reviewer)) = 0) then
    raise exception 'legal review needs a named reviewer';
  end if;

  insert into public.locale_release (
    locale, production,
    native_review, native_reviewer, native_reviewed_at,
    legal_review, legal_reviewer, legal_reviewed_at,
    note
  ) values (
    p_locale, p_production,
    p_native_review, nullif(trim(coalesce(p_native_reviewer, '')), ''), v_native_at,
    p_legal_review, nullif(trim(coalesce(p_legal_reviewer, '')), ''), v_legal_at,
    nullif(trim(coalesce(p_note, '')), '')
  )
  on conflict (locale) do update set
    production = excluded.production,
    native_review = excluded.native_review,
    native_reviewer = excluded.native_reviewer,
    native_reviewed_at = excluded.native_reviewed_at,
    legal_review = excluded.legal_review,
    legal_reviewer = excluded.legal_reviewer,
    legal_reviewed_at = excluded.legal_reviewed_at,
    note = excluded.note,
    updated_at = now();

  insert into public.platform_audit (actor_user_id, action, scope, scope_key, summary, after_data)
  values ((select app.current_user_id()), 'locale_release.set', 'locale_release', p_locale,
          format('%s: produced %s, native review %s, legal review %s',
                 p_locale, p_production, p_native_review, p_legal_review),
          jsonb_build_object('production', p_production,
                             'native_review', p_native_review,
                             'native_reviewer', p_native_reviewer,
                             'legal_review', p_legal_review,
                             'legal_reviewer', p_legal_reviewer));
end;
$$;

revoke all on function app.locale_release_set(text, text, text, text, text, text, text) from public;
grant execute on function app.locale_release_set(text, text, text, text, text, text, text) to app_user;

-- ── the honest opening record ──────────────────────────────────────────────
-- English is the language the product is authored in, so native review does not
-- apply to it. Arabic and Spanish were both produced with machine assistance
-- inside build phases; neither has a native review on record, and this says so
-- rather than inheriting a review nobody performed. Arabic has been in
-- production since phase F, which is a fact about usage, not about review.
insert into public.locale_release (locale, production, native_review, legal_review, note) values
  ('en', 'source', 'not_applicable', 'not_applicable',
   'The language the product copy is authored in.'),
  ('ar', 'machine_assisted', 'not_started', 'not_started',
   'Shipped since phase F and in daily production use. No formal native-speaker or legal review is on record; usage is not review.'),
  ('es', 'machine_assisted', 'not_started', 'not_started',
   'Catalogue completed in H29. Awaiting native-speaker review before the language is offered to the public (FEATURE_LOCALE_ES).')
on conflict (locale) do nothing;
