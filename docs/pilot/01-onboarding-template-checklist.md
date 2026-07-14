# Onboarding + template-selection checklist

> A tickable, operator-facing checklist for one pilot org. Goal: **cold org →
> configured workspace → first job in under 30 minutes.** Print it or copy it per
> pilot. Full narrative in [`00-pilot-org-setup.md`](00-pilot-org-setup.md).
>
> **Org:** ________________________  **Owner email:** ________________________
> **Date:** ____________  **Operator:** ____________  **Base currency:** ________

---

## Pre-flight (platform-level — confirm once, reuse across pilots)

- [ ] `GET /api/health` → `200`, `db` + `storage` healthy
- [ ] DB at migration `0064` (`pnpm db:migrate`, idempotent)
- [ ] Storage buckets set up (`pnpm storage:setup`)
- [ ] `pnpm smoke:prod -- https://idaraworks.vercel.app` passes (18/18)
- [ ] **[OWNER ACTION]** Email provider decision recorded:
      `RESEND_API_KEY` set → invites emailed · unset → hand invite links over manually
- [ ] **[OWNER ACTION]** Crons: `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` set if the
      pilot needs nightly digests/exceptions live (otherwise in-app flows only)
- [ ] Confirmed: billing/e-invoice providers **disabled in prod** (no real charges) —
      expected for a pilot

---

## Stage 1 — Account & org (target: 5 min)

- [ ] Owner signed up at `/signup` (name, email, password ≥10 chars)
- [ ] Email confirmed (hosted DB requires the confirm-link click)
- [ ] Org created at `/onboarding`: name, **country (GCC)**, base currency, six-day week
- [ ] Landed on `/o/<orgId>` (Today) — note the **orgId**: ________________________
- [ ] Verified the bootstrap: owner is a member; 7 roles exist; plan = `growth`,
      state = `trialing` (visible under **Members** and **Subscription**)

---

## Stage 2 — Choose the configuration path & install template (target: 10 min)

**Decision — tick one:**

- [ ] **Path A · Guided (AI) onboarding** (recommended) — `/o/<orgId>/onboarding`
- [ ] **Path B · Manual fallback** — `/o/<orgId>/settings/configuration` → *Install
      boatbuilding template*

> Both call the **same** governed `installTemplate` pipeline. Path A adds a structured
> intake + previewable proposal + undoable apply. Path B is the always-available
> fallback (no questionnaire). **Template #1 = `boatbuilding_marine_v1`** is the only
> shipped template today.

**If Path A (guided):**

- [ ] Filled intake: job term EN/AR (default `Boat`/`قارب`), auto-approve LPO/MR
      thresholds (minor units, optional), six-day week, VAT-registered
- [ ] Reviewed the **preview** diffs (this is the "best screen in the app")
- [ ] Confirmed auto-approve numbers were **accepted** (not rejected by the F-28 2×
      cap — if rejected, lower them)
- [ ] Clicked **Apply** → ~20 config revisions + approval rules seeded
- [ ] (If wrong) used **Undo** to revert cleanly, then retried

**If Path B (manual):**

- [ ] Clicked **Install boatbuilding template**
- [ ] Saw the "template installed" confirmation

**Template install — verify (either path):**

- [ ] Configuration page shows **installed: `boatbuilding_marine_v1` v1**
- [ ] Jobs → new-job preset list shows the **9 boat presets**
- [ ] A job preset produces a hull-number reference like `24C-001`
- [ ] 11 stages present on a job's stage board
- [ ] Item categories, expense categories, quote sections populated

---

## Stage 3 — Terminology (target: 2 min — usually skip)

- [ ] Reviewed the terminology chips on **Configuration** (16 term keys)
- [ ] Marine defaults acceptable? If yes → **skip overrides**
- [ ] (If needed) Overrode any term (EN + AR singular/plural + AR gender) via the
      **Terminology card**; each save is an undoable revision

---

## Stage 4 — Seed masters (target: 8 min — see doc 03)

Minimum viable to run a pilot; import or hand-enter.

- [ ] **Customers** — at least the pilot's real active customers
- [ ] **Suppliers** — the suppliers you'll raise LPOs against
- [ ] **Employees** — the workforce (remember: employees ≠ users, no seats consumed)
- [ ] **Items** — catalog items (categories must already exist from the template)
- [ ] Spot-checked an imported record on its list page
- [ ] (Optional) Exported one entity (`/api/o/<orgId>/export?entity=customers`) to
      confirm the round-trip

---

## Stage 5 — People & access (target: 5 min — see doc 02)

- [ ] Owner confirmed as first admin
- [ ] Second admin invited (continuity) — role `admin`
- [ ] Workshop manager / foreman / procurement / accounts invited as needed
- [ ] Foreman(s): field-seat access confirmed (assigned jobs only; no cost/price)
- [ ] **[OWNER ACTION]** invite links delivered (email, or manual hand-off if no
      email provider)
- [ ] At least one invitee accepted (`/invite/<token>`) and reached the org

---

## Stage 6 — First job & parity gate (target: 5 min)

- [ ] Created the **first job** from a preset (hull number allocated)
- [ ] (Optional) Filed a first **daily report** — heartbeat works end-to-end
- [ ] **Costing parity:** onboarded config reproduces the S5 golden
      (**ex-labour 290000 / total 395000**) — matches ✔ / n/a ☐

---

## Stage 7 — Sign-off

- [ ] `/api/health` still green after setup
- [ ] Audit log shows the full setup trail (org create → template → revisions →
      invites → imports → first job)
- [ ] Owner walked through Today on a **phone at ~375px** (mobile-first check)
- [ ] Owner switched UI to **Arabic/RTL** on Account → Language and confirmed layout
- [ ] Handover notes filed; open **[OWNER ACTION]s** listed below

**Open owner actions carried into the pilot:**
`______________________________________________________________________`
`______________________________________________________________________`

---

## The S8 parity gate — what "configured correctly" means

The onboarding is a **validator around templates, not an agent**: whatever path you
take, the result is the governed template config, so the numbers are reproducible.
The acceptance gate is that a job created under the onboarded preset costs out to the
**same golden** the platform verifies in its S8 production demo (ex-labour `290000`,
total `395000`, to the minor unit). If a scripted parity check diverges, the config
is wrong — re-check the template install and expense-category costing mappings before
proceeding.

## Manual fallback — when the guided path won't do

Use Path B (**Configuration → Install boatbuilding template**) when:

- the AI onboarding page errors or is disabled for the org,
- you're re-configuring an existing org (guided onboarding targets cold orgs), or
- the customer prefers to skip the questionnaire.

Path B reaches the identical config state; you then adjust terminology and
per-artifact config by hand on the Configuration page. Everything remains a diffable,
undoable `config_revision`.
