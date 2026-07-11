-- 0002_revoke_builtin_role_privileges
-- Found by the tenancy harness on the HOSTED project (Phase B hosted run):
-- Supabase's default privileges grant anon/authenticated on new public tables
-- (PostgREST convention). RLS already default-denies them (no policy TO those
-- roles), but doc 10 #9 default-deny applies at the grant layer too — and the
-- harness test "built-in roles hold no table privileges" enforces it forever.
-- service_role is deliberately untouched (platform-managed, equivalent to owner
-- access; its KEY is banned from app runtime per phase2/10 #1 instead).
-- Rollback note: re-granting is a one-line GRANT if ever needed; non-destructive.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon;
    revoke all on all sequences in schema public from anon;
    revoke all on all functions in schema public from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on all tables in schema public from authenticated;
    revoke all on all sequences in schema public from authenticated;
    revoke all on all functions in schema public from authenticated;
  end if;
end
$$;

-- And stop FUTURE tables created by the migration role from inheriting them:
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on tables from authenticated;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on sequences from authenticated;
alter default privileges in schema public revoke all on functions from anon;
alter default privileges in schema public revoke all on functions from authenticated;
