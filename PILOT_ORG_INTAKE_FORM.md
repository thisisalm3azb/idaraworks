# Pilot Organization — Intake Form (owner fills, then I configure)

This is the **single consolidated input form** for configuring the first controlled pilot org. Fill
every field; leave a blank or write "N/A" where it doesn't apply. **I will not create any real org,
user, invitation, or commercial configuration until you return this completed + approved.** Values in
`[…]` are system-constrained options or recommended defaults — override any of them. **No value here is
invented by me; every business-specific field is blank for you.**

Never put secret values (passwords, API keys, tokens) in this form or in chat — those go only to their
provider dashboards / Vercel env (see `PILOT_CREDENTIAL_MATRIX.md`).

---

## A. Organization identity

| Field | Your value | Notes / constraints |
| --- | --- | --- |
| Legal organization name | `__________` | as it should appear on invoices/PDFs |
| Display name | `__________` | short name shown in the app header |
| Organization slug/identifier | `__________` | optional; lowercase-kebab (auto-derived if blank) |
| Country | `__________` | GCC-first: `[AE, SA, QA, KW, BH, OM]` (drives holidays + VAT default) |
| Timezone | `__________` | e.g. `[Asia/Dubai]` for AE, `[Asia/Riyadh]` for SA |
| Base currency | `__________` | one of `[AED, SAR, QAR, KWD, BHD, OMR, USD, EUR]` (KWD/BHD/OMR are 3-decimal) |
| Default locale | `__________` | `[ar]` or `[en]` (the app is fully bilingual RTL/LTR; per-user overridable) |
| Arabic or English primary | `__________` | which the owner + field staff read first |

## B. Industry & template

| Field | Your value | Notes |
| --- | --- | --- |
| Industry / business type | `__________` | the pilot target is a project-based industrial SME |
| Template | `[Boatbuilding / Marine]` | **the only shipped template** (`boatbuilding_marine_v1`: 11 stages, 9 boat presets). If your pilot is NOT marine, tell me — we onboard via the manual/AI config path onto the same object model (a "Job" with your own stage names), not a new template. |
| Terminology overrides | `__________` | what to call the core object + docs, e.g. Job/Boat/Work-Order · Purchase-Order · Goods-Receipt · Daily-Report. Leave blank to use the template defaults. |

## C. People (owner + initial users)

| Field | Your value | Role |
| --- | --- | --- |
| Primary owner — name | `__________` | `owner` (full control; billing) |
| Primary owner — email | `__________` | receives the first sign-in |
| User 2 — name / email | `__________` | role: one of `[admin, manager, foreman, procurement, accounts, viewer]` |
| User 3 — name / email | `__________` | role: `[…]` |
| User 4 — name / email | `__________` | role: `[…]` |
| (add rows as needed) | | |

**Role guide** (see `docs/guides/role-guides.md`): `owner`/`admin` = full office; `manager` = plans +
approves + decides MRs (sees supply money, not labour cost); `foreman` = field/mobile daily reports +
assigned jobs (NO money/cost/labour ever); `procurement` = purchasing; `accounts` = money/AR/exports;
`viewer` = read-only redacted. Field seats (foreman) are free/unlimited.

## D. Configuration

| Field | Your value | Notes |
| --- | --- | --- |
| VAT registered? | `[yes / no]` | drives ex-VAT vs inc-VAT costing basis (PB-3). QA/KW orgs = VAT-disabled mode. |
| VAT rate | `__________` | e.g. `[5%]` UAE/SA standard; country-derived if blank |
| Approval rule(s) | `__________` | per subject (payment / material-request / purchase-order): mode `none` / `every` / `above <amount>`; and "auto-approve below <amount>". Leave blank for no approvals. |
| Reporting structure | `__________` | who submits daily reports (foremen), who reviews (manager/admin), any backfill window |
| Billing points | `[on_acceptance 60% / stage:delivery 40%]` | template default per boat; editable per job |

## E. Data & first work

| Field | Your value | Notes |
| --- | --- | --- |
| Initial projects/jobs | `__________` | 1–3 real jobs to start (name + boat/model + selling price if any) |
| Import files available? | `[yes / no]` | customers / employees / items as CSV (guided import; manual entry is the fallback). If yes, share the CSVs (no secrets). |

## F. Pilot logistics

| Field | Your value | Notes |
| --- | --- | --- |
| Support contact(s) | `__________` | who the pilot users contact; who escalates (see `PILOT_SUPPORT_CHECKLIST.md`) |
| Pilot start date | `__________` | when the first user logs in |
| Pilot success goals | `__________` | e.g. "foremen submit daily reports for 2 weeks", "owner reads the digest", "one job costed end-to-end" (see `PILOT_SUCCESS_SCORECARD.md` for the measurable set) |

---

## Recommended pilot profile (accept or override in the fields above)

- **Business type:** one arm's-length GCC project-based industrial SME (boatbuilding/marine fits
  template #1 best; any project/work-order shop works via the manual config path).
- **Size / users:** 1 org · **3–6 users** — 1 owner, 1 admin/manager, 2–3 foremen (field), optionally
  1 accounts. Keep it small enough to support hands-on.
- **Duration:** **2–4 weeks** (see `PILOT_LAUNCH_PLAN.md`).
- **Enable initially:** onboarding + template, jobs/stages, **daily reporting on mobile**, issues,
  approvals (if the org wants them), purchasing (MR→PO→GRN), costing, quotes→invoice→**payment
  recorded manually (no real gateway)**, owner digest, exports.
- **Keep disabled:** real payment collection + e-invoice submission (D1-gated), AI narration
  (deterministic digest is the product), OAuth (email+password is simpler for a pilot), automated
  nightly workers until Inngest is provisioned (run on demand / founder triggers).
- **Founder support:** **high** — founder onboards the admin + first users hands-on and watches the
  first daily-report + first approval + first invoice, then steps back (per the S11 rehearsal model).

This remains the safest recommendation: it exercises the full operational→money loop with real users
and real data while taking **no real money** and touching **no D1-gated path** — so a pilot cannot
create a financial/legal obligation. See the final summary + `PILOT_LAUNCH_PLAN.md` §0 for the full
rationale.
