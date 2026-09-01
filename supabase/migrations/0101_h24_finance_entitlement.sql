-- H24 — the finance capability key. Same law as 0099 (D13/H23-D8): seeded
-- ENABLED on every plan including free; surfaces stay invisible behind
-- FEATURE_FINANCE_SURFACES until the whole workflow is verified. Mirrors
-- src/platform/entitlements/catalogue.ts (parity test).
insert into public.entitlement_def (key, kind) values ('cap.finance', 'feature');

insert into public.plan_entitlement (plan_key, entitlement_key, enabled)
select p.key, 'cap.finance', true
from public.plan p
where p.key in ('free', 'starter', 'growth', 'business');
