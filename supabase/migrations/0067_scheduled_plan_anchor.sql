-- 0067_scheduled_plan_anchor (add-on model fix, integration-test finding): scheduled downgrades
-- anchored on org_plan_state.updated_at could be deferred FOREVER — the touch_updated_at trigger
-- (0005) bumps updated_at on every later write (dunning fields, provider sync), pushing the
-- period-boundary math forward each time. Record the scheduling moment IMMUTABLY instead.
-- Forward-only, expand-only: adds a column + trigger and re-creates the 0066 scan to return it.
-- No applied migration file is modified.

alter table public.org_plan_state
  add column if not exists scheduled_plan_at timestamptz;

-- Auto-stamp on the transition (any writer path — advance_subscription included), auto-clear when
-- the schedule is cleared. An EXPLICIT scheduled_plan_at in the same UPDATE wins (ops/tests can
-- backdate); the stamp only fires when the caller did not provide one.
create or replace function app.touch_scheduled_plan_at()
returns trigger
language plpgsql
as $$
begin
  if new.scheduled_plan_key is distinct from old.scheduled_plan_key
     and new.scheduled_plan_at is not distinct from old.scheduled_plan_at then
    new.scheduled_plan_at := case when new.scheduled_plan_key is null then null else now() end;
  end if;
  return new;
end;
$$;

drop trigger if exists org_plan_state_touch_scheduled_plan_at on public.org_plan_state;
create trigger org_plan_state_touch_scheduled_plan_at
  before update on public.org_plan_state
  for each row execute function app.touch_scheduled_plan_at();

-- Replace the 0066 scan to carry the immutable anchor (updated_at kept as the legacy fallback for
-- rows scheduled before this migration).
drop function if exists app.scheduled_plan_scan();
create or replace function app.scheduled_plan_scan()
returns table (
  org_id uuid, billing_state text, scheduled_plan_key text,
  period_start timestamptz, scheduled_plan_at timestamptz, updated_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select org_id, billing_state, scheduled_plan_key, period_start, scheduled_plan_at, updated_at
  from public.org_plan_state
  where scheduled_plan_key is not null
$$;
revoke all on function app.scheduled_plan_scan() from public;
grant execute on function app.scheduled_plan_scan() to app_user;
