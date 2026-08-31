-- 0083_document_share_resolver (H22.0 — resolving a share link without RLS)
--
-- A share link is used by someone who is not signed in and belongs to no
-- organization, so the read cannot go through app_user's tenant policies: there
-- is no current_org_id to check against. The existing customer-update share
-- solved this with a SECURITY DEFINER function that takes the token hash and
-- returns only what that one token entitles the caller to. This mirrors it.
--
-- Why a function rather than a policy: a policy would have to be written for an
-- anonymous role, which means the anonymous role gets SELECT on the table and
-- the correctness of every future query depends on remembering the predicate.
-- A function has exactly one entry point, checks expiry and revocation itself,
-- and returns a subject reference — never the token, never a row the caller did
-- not ask for.

create or replace function app.resolve_document_share(p_token_hash text)
returns table (
  share_id uuid,
  org_id uuid,
  subject_type text,
  subject_id uuid
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select s.id, s.org_id, s.subject_type, s.subject_id
  from public.document_share s
  where s.token_hash = p_token_hash
    and s.revoked_at is null
    and s.expires_at > now()
  limit 1;
$$;

comment on function app.resolve_document_share(text) is
  'Resolve a share token hash to its one document. Returns nothing for an unknown, revoked or expired token so the caller cannot tell those apart.';

revoke all on function app.resolve_document_share(text) from public;
grant execute on function app.resolve_document_share(text) to app_user;

-- Viewing is recorded separately so the read path stays a pure function. It
-- deliberately cannot resurrect a dead link: the same expiry and revocation
-- predicate applies, so counting a view on a revoked link is impossible.
create or replace function app.record_document_share_view(p_token_hash text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.document_share
  set view_count = view_count + 1, last_viewed_at = now()
  where token_hash = p_token_hash
    and revoked_at is null
    and expires_at > now();
$$;

revoke all on function app.record_document_share_view(text) from public;
grant execute on function app.record_document_share_view(text) to app_user;
