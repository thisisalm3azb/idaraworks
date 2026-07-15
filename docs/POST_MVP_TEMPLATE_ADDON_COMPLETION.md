# Template Catalogue + Modular Add-on Subscription Model — Completion Report

**Status: COMPLETE.** Post-MVP expansion (NOT S12; S0–S11 historical scope unchanged). Everything
below is verified on the deployed production commit; the S0–S11 guarantees (tenancy/RLS second
wall, billing-state sole writer, FR-9 read-only law, provider-disabled prod, redaction walls)
were re-proven by the full regression + a 22-agent adversarial review + a 42-assertion
production-backed demo.

## 1. Templates available (8)

| Key | EN / AR | Target |
| --- | --- | --- |
| `boatbuilding_marine_v1` | Boatbuilding & Marine / بناء القوارب والصناعات البحرية | boatyards (preserved verbatim: 11 stages, 9 presets) |
| `manufacturing_workshop_v1` | Manufacturing & Workshop / التصنيع والورش | fabrication, metalwork, joinery, project factories |
| `service_business_v1` | Service Business / أعمال الخدمات | maintenance, repair, cleaning, field service |
| `construction_v1` | Construction & Contracting / المقاولات والإنشاءات | small contractors, fit-out, MEP, subcontractors |
| `food_beverage_v1` | Food & Beverage / الأغذية والمشروبات | restaurants, cafés, bakeries, catering |
| `online_store_v1` | Online Store / المتجر الإلكتروني | electronics/phone/accessory retail + online sellers |
| `agriculture_v1` | Farms & Agriculture / المزارع والزراعة | crop, livestock, mixed farms |
| `generic_operations_v1` | Generic Operations / العمليات العامة | anything else — neutral terminology, zero boat language |

## 2. What each template configures (structure ONLY — never data)

Terminology (incl. Arabic gender/plurals) · workflow stages with weights (Σ=100) · job status set ·
category sets (items / expenses / quote sections) · reference-number patterns · role presets with
money-privilege baselines · job presets (available models, not created rows) · holiday calendars ·
approval defaults · advisory enabled/optional modules. **Installing a template never seeds jobs,
employees, suppliers, users, or transactions** (demo-asserted: 0 domain rows after every install).
The customer still enters their own org info, users, thresholds, projects, suppliers, customers,
tax and commercial settings. Full reference: `docs/templates/TEMPLATE_CATALOGUE.md`,
`TEMPLATE_CONFIGURATION_REFERENCE.md`.

## 3. AI-selection behavior

Onboarding intake asks about the business (free-text description EN or AR + structured answers),
then a **transparent deterministic classifier** scores all 8 templates (keyword +3, phrase-overlap
+2×ratio; MIN_SCORE 3 → generic fallback; MIN_LEAD 2 → honest "ambiguous" flag), recommends the
best match **with the reason shown**, lists scored alternatives, and lets the founder pick a
different template ("use this instead" creates a fresh session — nothing mutated). The proposal
(template + terminology + roles + modules) is **reviewed and explicitly applied — never silently
installed** (install happens only inside the permission-gated Apply; demo-asserted). Proposals are
validated against the registry + per-template privilege baselines — no arbitrary config can leave
the schema. The AI *provider* seam remains an unwired stub: no LLM is called anywhere; enabling one
later can only add prose, never change config. Rules: `docs/templates/AI_TEMPLATE_SELECTION_RULES.md`.

## 4. Manual fallback behavior

Identical experience with zero AI dependency: same catalogue, structured questions, transparent
match scores, manual chooser (dropdown of the 8 real templates — nothing fake is offered), and
everything editable after apply in Settings → Configuration. The deterministic path IS the shipped
path.

## 5. Free base plan (launch definition — `docs/commercial/FREE_PLAN_DEFINITION.md`)

One organization · dashboard/Today · employee directory (records **unlimited**) · customers +
suppliers (basic records) · jobs/projects + stages + tasks · daily reports · issues · manual data
entry · **3 office login seats + 3 viewer seats · field (foreman) logins FREE and unlimited** ·
10 active jobs · 1 GB storage · core exports. New orgs start on a **14-day full-featured Growth
trial** (explicit `trial_end` stamped at creation — 0068), then land on **free/active** — never
suspension, never data loss.

## 6. Add-on catalogue (USD/month, tax-exclusive, indicative pending owner ratification)

**Purchasable now — available (17):** members_10 $5 (stackable) · storage_25gb $4 (stackable) ·
quotes_invoices $5 · payments_ar $5 · expenses_cashbook $4 · purchase_requests $4 ·
purchase_orders $5 · goods_receiving $3 · items_catalogue $3 · approval_workflows $4 ·
job_costing $7 · labour_timesheets $5 · quote_vs_actual $3 · owner_digest $5 · customer_updates $3 ·
data_import $3 · audit_history $4.
**Purchasable now — manual process (2):** extra_org $9 (stackable) · priority_support $9.
**Total purchasable: 19** — owner decision (2026-07-15): launch at 19; additions reviewed **after
founder testing** by real demand, never by listing a no-op. Yearly = 10× monthly (2 months free);
AED companion prices seeded alongside.

## 7. Market-research justification

17 products verified on official 2026 pricing pages (Odoo, Zoho, QuickBooks, Xero, FreshBooks,
Monday, ClickUp, Jobber, ServiceM8, Shopify, Katana, Cin7, MRPeasy, Buildertrend, Farmbrite +
regional; Procore/AgriWebb explicitly marked unverifiable) — sources, access dates, limits and
add-on pricing recorded in `docs/commercial/ADDON_MARKET_RESEARCH.md`; band mapping in
`ADDON_PRICING_RATIONALE.md`. All five owner anchors kept (accounting ≈$9 → the Finance bundle,
doc-logo $2 + app-branding $1 retained as anchors on deferred items, quotes+invoices $5,
members-10 $5 — knowingly 4–10× below market per seat). Decisions log:
`docs/commercial/OWNER_PRICING_DECISIONS.md` (ratification checklist gates public launch).

## 8. Bundles (discounted collections of the SAME add-on keys — no second entitlement system)

starter_ops $7 · finance $9 · procurement $12 · project_control $12 · growth $19 · full_ops $29
(vs $69 individually, −58%). Pricing page shows bundles first, grouped add-ons second, live
monthly total (one currency, ex-VAT labelled in EN+AR), free-base summary, usage/seats.

## 9. Credential-gated (visible, honestly not purchasable yet): automation_workers $5 (Inngest) ·
email_notifications $3 (Resend) · ai_pack $6 (AI provider) · oauth_login $3 (OAuth).

## 10. D1-gated: real payment collection and e-invoice submission — never sold separately;
e-invoicing is included inside quotes_invoices when D1 opens. No card data anywhere.

## 11. Deferred (never shown purchasable; $0, no active price rows): inventory_stock ·
multi_location · multi_currency · whatsapp_pack · api_webhooks · exports_extended ·
branding_docs · branding_app (the last three honesty-reclassified by 0070 — sold keys must have a
real enforcement site; parity is now unit-tested so this cannot regress).

## 12. Final deployed commit

**`49ddb03`** — CI green on exactly this commit; Vercel serves it (`/api/health` commit match);
production smoke **17/17**. (This report lands as a trailing docs-only commit.)

## 13. Migrations

Hosted ledger **0000–0070** (this project added 0065 addon model · 0066 lifecycle scans ·
0067 scheduled-plan anchor · 0068 explicit trial_end · 0069 accept-invite peek ·
0070 honesty reclassification). **Next: 0071.** Forward-only throughout; no applied file mutated.

## 14. CI and test results

- Unit: **437/437** (31 files) — incl. template honesty/leakage, classifier scenarios, catalogue
  parity, enforcement parity, i18n domain-noun guard.
- Hosted integration: **273/273 effective** (271 in-run + 2 tail-latency timeouts green in
  isolation; caps hardened) — incl. addon-model 19, subscription-roundtrip 7, seat-accept 4,
  bleed/tenancy harnesses with org_addon coverage.
- GitHub CI: **green on `49ddb03`** (quality: gitleaks/format/lint/typecheck/unit/audit/build/e2e +
  integration on the CI stack). Two CI infra fixes landed en route: gitleaks false-positive
  allowlist (template key slugs) and a bulk-advisory audit script replacing npm's retired
  endpoints (491 packages, 0 high/critical).
- Adversarial review: 22 agents, 5 lenses → **1 critical + 8 material confirmed, ALL fixed with
  regression coverage** (the critical: a protected-org trial-expiry time bomb — see §15); 7
  findings refuted; minors triaged/documented.
- Production demo: **42/42 PASS** (`tooling/scripts/pta8-demo.ts`, self-cleaning).

## 15. Production baseline

**Exactly [Alpha Marine `d22b2098…`, TESTING `9fcaa697…`] — verified byte-identical
`org_plan_state` before/after every sweep and after cleanup**; both growth/trialing with
`trial_end NULL`, which since 0068 means **no deadline by contract** (the pre-0068 fallback that
would have auto-downgraded them ~2026-07-25 was found by the adversarial review and eliminated;
regression-pinned in unit + integration). 12 leaked synthetic test orgs (from a killed test run)
were removed via the guarded cleanup (dry-run evidence → apply → verified). **One pending
approval:** 22 orphaned synthetic auth users (`s5-/s6demo-/s9imp-/bleed-*@example.com`, zero org
data) await explicit owner approval for deletion — the destructive-cleanup classifier paused it;
the real founder account `abdulla.alojan@gmail.com` is excluded and kept.

## 16. Evening onboarding-test instructions (owner)

Open **https://idaraworks.vercel.app/signup** on your phone (and once on desktop). You already
have the account `abdulla.alojan@gmail.com` — sign in at `/login`, or register fresh.

1. **Create a disposable org** (name it clearly, e.g. `TA Test Cafe`) — country/currency of your
   choice.
2. **Onboarding:** describe a business in your own words — try a restaurant, then re-run with a
   metal workshop, a contractor, a farm, an electronics shop. Each time check: the recommendation
   + its reason, the alternatives list, and that NOTHING installs until you press Apply. Try
   "Use this template instead" once. Leave the job-term fields empty once (template's own term
   should stand) and type your own term once (yours should stick).
3. **Pricing page** (Settings → Subscription): bundles first, add-ons grouped, monthly total
   updates, ex-VAT wording, credential-gated items shown but not buyable, deferred items not
   listed for sale, **no payment button anywhere** (provider disabled — expected).
4. **Arabic:** switch at `/account` → العربية; re-walk onboarding + pricing in RTL.
5. **375px:** the whole journey on your phone; field report flow one-handed.
6. Known-and-expected: PDFs stay "pending", digest/exception cards empty, no emails (Inngest/
   Resend unprovisioned — credential-gated add-ons cover these later).
7. When done, tell me the org name(s) you created and I'll run the guarded inspection + cleanup
   (nothing deleted without your approval).

Add-on purchases in prod are intentionally impossible (D1 + provider disabled) — the full
purchase→entitlement→downgrade loop is proven by the fake-provider demo + integration suites.
