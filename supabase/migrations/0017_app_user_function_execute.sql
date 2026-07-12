-- 0017_app_user_function_execute
-- Fix for 0016 (both hosted-applied → forward-only): 0016's blanket
-- "revoke all on all functions in schema public from public" was a no-op on
-- hosted (pgcrypto lives in the `extensions` schema there; public has 0
-- functions), but on a fresh local/CI Supabase stack pgcrypto installs into
-- `public`, so the revoke stripped app_user's EXECUTE on `gen_random_uuid` —
-- which every table's `default gen_random_uuid()` needs at INSERT time under the
-- inserting role's privileges. Result: inserts fail on the local stack while
-- passing on hosted.
--
-- Restore app_user's function access explicitly (app_user is the trusted server
-- role). PUBLIC / anon / authenticated stay revoked (0016) — the built-in roles
-- still cannot execute any public function; only app_user regains it.
-- Rollback note: forward-only; non-destructive.

grant execute on all functions in schema public to app_user;
grant execute on all routines in schema public to app_user;
alter default privileges in schema public grant execute on functions to app_user;
alter default privileges in schema public grant execute on routines to app_user;
