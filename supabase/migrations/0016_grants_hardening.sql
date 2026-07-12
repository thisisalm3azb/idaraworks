-- 0016_grants_hardening (S0 checklist §3 "grants_hardening", renumbered)
-- The default-deny sweep: a defensive belt over the per-migration grants and
-- 0002's built-in-role revocation. app_user keeps exactly the column-scoped
-- grants each migration set — this migration does NOT re-grant app_user (that
-- would undo the column-level scoping); it only REVOKES from the pseudo-role
-- PUBLIC and the built-in Supabase roles, and sets those revocations as the
-- default for future public objects too.
--
-- The real gap this closes: FUNCTIONS default to PUBLIC EXECUTE in Postgres, so
-- any public-schema function (now or future) would be callable by every role
-- unless revoked. (App helpers live in schema `app`, granted explicitly; the
-- `app`/`storage` schemas are untouched here — only `public` is swept.)
-- Rollback note: forward-only; re-grants would be per-object. Non-destructive to
-- app_user, which is never revoked here.

-- ── existing objects ─────────────────────────────────────────────────────────
revoke all on all tables in schema public from public;
revoke all on all sequences in schema public from public;
revoke all on all functions in schema public from public;
revoke all on all routines in schema public from public;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke all on all routines in schema public from anon, authenticated;

-- ── future objects created in public (by the migration owner) ────────────────
alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;
alter default privileges in schema public revoke all on routines from public, anon, authenticated;
