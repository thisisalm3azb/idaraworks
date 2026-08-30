-- 0080_job_origin_backfill (H21 follow-up - tell the truth about quoted work)
--
-- 0079 added job.origin with default 'direct', but the quotation acceptance
-- path never passed its own origin, so every work record ever created from an
-- accepted quotation was labelled 'direct'. The application side is fixed; this
-- corrects the rows already written.
--
-- The correction is DERIVED, not guessed: quote.converted_job_id is the
-- authoritative link written inside the acceptance transaction, so a job it
-- points at was, by definition, created from that quotation.
--
-- Two guards keep this from overreaching:
--   - only rows still sitting on the 'direct' default are touched, so a value
--     something else set on purpose is never overwritten;
--   - rows carrying a source_opportunity_id are left alone, because work that
--     started from an opportunity and later gained a quotation genuinely has
--     an opportunity origin. None exist today; the guard is for tomorrow.
--
-- No history is destroyed: origin records provenance, and these rows never had
-- a provenance recorded, only a default.

update public.job j
set origin = 'quotation'
where j.origin = 'direct'
  and j.source_opportunity_id is null
  and exists (
    select 1 from public.quote q
    where q.converted_job_id = j.id
      and q.org_id = j.org_id
  );
