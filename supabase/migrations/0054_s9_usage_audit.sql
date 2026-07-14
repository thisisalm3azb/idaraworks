-- 0054_s9_usage_audit (S9 part 3): append-only usage metering + a platform-context audit writer.
-- Forward-only.

-- ── usage_event: append-only, idempotent, period-aware usage log ───────────────────────────────
-- Billing-grade metering (doc: org-scoped, idempotent, concurrency-safe, period-aware,
-- reconcilable). APPEND-ONLY (no update/delete grant — D-1.7): the current value for a meter is
-- sum(delta) over the org+meter+period. Idempotency is a UNIQUE (org, meter_key, dedup_key) — a
-- duplicate provider/worker delivery inserts nothing (ON CONFLICT DO NOTHING at the app layer).
-- Corrections are NEGATIVE-delta rows, never edits. Concurrency-safe: distinct dedup_keys never
-- conflict; identical ones collapse to one.
create table public.usage_event (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org (id) on delete restrict,
  meter_key text not null check (length(meter_key) between 1 and 60),
  period_key text not null check (length(period_key) between 1 and 20), -- e.g. '2026-07' month bucket
  dedup_key text not null check (length(dedup_key) between 1 and 200),
  delta bigint not null,
  created_at timestamptz not null default now(),
  constraint usage_event_id_org_uq unique (id, org_id)
);
create unique index usage_event_dedup_uq on public.usage_event (org_id, meter_key, dedup_key);
-- Hot read: sum a meter for an org in a period.
create index usage_event_sum_idx on public.usage_event (org_id, meter_key, period_key);
alter table public.usage_event enable row level security;
create policy usage_event_read on public.usage_event
  for select to app_user using (org_id = (select app.current_org_id()));
-- Tenant may INSERT its own metered usage (e.g. a per-request meter), org-pinned; NO update/delete.
create policy usage_event_insert on public.usage_event
  for insert to app_user with check (org_id = (select app.current_org_id()));
grant select, insert on public.usage_event to app_user;

-- ── record_platform_audit: write a TENANT-VISIBLE audit row from a platform (no-tenant) context ──
-- Subscription lifecycle changes originate from provider webhooks / the lifecycle worker, which run
-- WITHOUT a tenant context (assert_platform_task). They must still appear in the tenant's own
-- audit_log (DoD: "subscription changes are audited"; "a support session is visible in the tenant's
-- own audit log"). audit_log is append-only (insert-only grant), so a DEFINER platform writer is the
-- clean path — it inserts the org's audit row directly, synchronously with the state change (never
-- deferred to an Inngest-gated worker). actor_user_id is nullable (a webhook has no user actor).
create or replace function app.record_platform_audit(
  p_org uuid,
  p_actor uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_summary text,
  p_after jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_platform_task();
  insert into public.audit_log (org_id, actor_user_id, action, entity_type, entity_id, summary, after_data)
  values (p_org, p_actor, p_action, p_entity_type, p_entity_id, p_summary, p_after);
  -- activity.entity_id is NOT NULL — fall back to the org id (subscription events are org-scoped).
  insert into public.activity (org_id, actor_user_id, verb, entity_type, entity_id, summary)
  values (p_org, p_actor, p_action, p_entity_type, coalesce(p_entity_id, p_org), p_summary);
end
$$;
revoke all on function app.record_platform_audit(uuid, uuid, text, text, uuid, text, jsonb) from public;
grant execute on function app.record_platform_audit(uuid, uuid, text, text, uuid, text, jsonb) to app_user;
