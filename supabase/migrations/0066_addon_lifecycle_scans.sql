-- 0066_addon_lifecycle_scans (add-on model part 2): platform (no-tenant) DEFINER scans for the
-- lifecycle sweep's add-on steps. org_addon and org_plan_state are tenant-read-only under RLS, so
-- the no-context worker client needs these (mirrors 0058's lifecycle_scan/subscription_recon_scan).
-- Forward-only, expand-only — no existing table or applied migration is modified.

-- ── addon_removal_scan: org_addon rows whose scheduled removal deadline has passed ──────────────
-- The sweep flips these to 'removed' via app.set_org_addon (0065, the sole writer). p_now is the
-- sweep's clock so the deadline math is deterministic and testable (like the TS window math).
create or replace function app.addon_removal_scan(p_now timestamptz)
returns table (org_id uuid, addon_key text, quantity int, source text, remove_at timestamptz)
language sql
security definer
set search_path = public, pg_temp
as $$
  select org_id, addon_key, quantity, source, remove_at
  from public.org_addon
  where status = 'removal_scheduled' and remove_at is not null and remove_at <= p_now
$$;
revoke all on function app.addon_removal_scan(timestamptz) from public;
grant execute on function app.addon_removal_scan(timestamptz) to app_user;

-- ── scheduled_plan_scan: orgs with a pending scheduled (downgrade) plan ─────────────────────────
-- The sweep applies the plan at period end (monthly anniversary of period_start — the
-- deterministic no-provider anchor) via the same advance_subscription path the webhook uses.
-- updated_at is returned as the scheduling-write reference for the boundary math.
create or replace function app.scheduled_plan_scan()
returns table (
  org_id uuid, billing_state text, scheduled_plan_key text,
  period_start timestamptz, updated_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select org_id, billing_state, scheduled_plan_key, period_start, updated_at
  from public.org_plan_state
  where scheduled_plan_key is not null
$$;
revoke all on function app.scheduled_plan_scan() from public;
grant execute on function app.scheduled_plan_scan() to app_user;

-- Guarded like the 0058 scans: callable only from the no-context platform client in practice, and
-- the returned columns are non-sensitive plan/add-on state — no cost data, no PII. app_user remains
-- NOBYPASSRLS everywhere else, so these stay the ONLY cross-org read of add-on/plan state.
