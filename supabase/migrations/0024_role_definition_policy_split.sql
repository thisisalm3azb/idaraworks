-- 0024_role_definition_policy_split (S1 review CM fix, part 2).
-- 0003's role_definition_tenant_isolation was FOR ALL — permissive policies OR
-- together, so it kept granting org-wide UPDATE and silently defeated 0023's
-- owner/admin-gated update policy. Split: reads stay org-wide (members see
-- their org's roles); the ONLY update path is 0023's archetype-gated policy.
-- (INSERT/DELETE have no app_user grant; bootstrap rows come from the
-- SECURITY DEFINER create_org_with_owner, which is not subject to app_user RLS.)
-- Rollback note: forward-only; policy replacement, non-destructive.

drop policy role_definition_tenant_isolation on public.role_definition;
create policy role_definition_select on public.role_definition
  for select to app_user
  using (org_id = (select app.current_org_id()));
