-- ═════════════════════════════════════════════════════════════════════════════
-- H23G — the HR capability keys: leave, payroll, expense claims.
--
-- Mirrors src/platform/entitlements/catalogue.ts (the entitlements parity test
-- asserts DB ⇔ code equality). Locked decision D8: seeded ENABLED on every
-- plan including free — the H23 system ships as part of the core product; a
-- commercial add-on split is a pricing decision the owner has not made, and
-- pricing hypotheses are never encoded as OFF switches on shipped capability.
-- Surfaces stay invisible regardless until FEATURE_HR_SURFACES releases them.
-- ═════════════════════════════════════════════════════════════════════════════

insert into public.entitlement_def (key, kind) values
  ('cap.leave', 'feature'),
  ('cap.payroll', 'feature'),
  ('cap.expense_claims', 'feature');

insert into public.plan_entitlement (plan_key, entitlement_key, enabled)
select p.key, e.key, true
from public.plan p
join public.entitlement_def e
  on e.key in ('cap.leave', 'cap.payroll', 'cap.expense_claims')
where p.key in ('free', 'starter', 'growth', 'business');
