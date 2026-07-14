-- 0060_s9_platform_table_policies (S9 fix): subscription_event, reconciliation, and platform_staff
-- are PLATFORM-ONLY (reached only via SECURITY DEFINER functions, which bypass RLS as owner; no
-- tenant grant). They were created RLS-ENABLED but with NO policy, which trips the tenancy harness
-- (a policy-less RLS-enabled table is a likely oversight). Declare the intent with an explicit
-- deny-all-tenant policy: a `for select using(false)` policy that grants a tenant NOTHING. The
-- harness's shape rule classifies a GUC-less SELECT policy as global-reference data, which must be
-- SELECT-only + carry no write grant — both true here (no grant at all), so a tenant read still
-- hits 42501 (missing grant) before RLS, keeping the two-org bleed NO_TENANT_READ expectation.
-- Idempotent (drop-if-exists) — this migration was first authored with `for all`. Forward-only.
drop policy if exists subscription_event_deny on public.subscription_event;
drop policy if exists reconciliation_deny on public.reconciliation;
drop policy if exists platform_staff_deny on public.platform_staff;
create policy subscription_event_deny on public.subscription_event for select to app_user using (false);
create policy reconciliation_deny on public.reconciliation for select to app_user using (false);
create policy platform_staff_deny on public.platform_staff for select to app_user using (false);
