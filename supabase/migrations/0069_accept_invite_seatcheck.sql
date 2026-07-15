-- 0069_accept_invite_seatcheck (adversarial-review fix): acceptInvite performed NO seat recount —
-- a pending invite created while the plan allowed it could be accepted AFTER a downgrade and
-- permanently overshoot the dropped seat cap (inviteMember's in-tx recount only guards CREATION).
--
-- The cap itself CANNOT be resolved in SQL: add-on limit DELTAS live in code
-- (src/platform/entitlements/addons.ts limitDeltas), so TypeScript resolves the limit and runs
-- the authoritative recount in-tx under the SAME per-org advisory lock as inviteMember.
-- This migration adds only the read half: a DEFINER peek of a pending invite's org + seat class,
-- so the accepting user — who has NO membership yet and therefore no org visibility — can
-- classify the seat BEFORE app.accept_invite runs. Returns zero rows for missing / accepted /
-- revoked / expired tokens; the caller then falls through to app.accept_invite, which raises
-- the canonical 'invite invalid or expired' (error surface unchanged).

create or replace function app.peek_invite(p_token_hash text)
returns table(org_id uuid, role_key text, archetype text)
language sql
stable
security definer
set search_path = ''
as $$
  select i.org_id, i.role_key, r.archetype
  from public.membership_invite i
  join public.role_definition r on r.org_id = i.org_id and r.key = i.role_key
  where i.token_hash = p_token_hash
    and i.accepted_at is null and i.revoked_at is null and i.expires_at > now();
$$;

revoke all on function app.peek_invite(text) from public;
grant execute on function app.peek_invite(text) to app_user;
