# IdaraWorks — Controlled-Pilot Launch Plan

> **What this is.** The practical 2–4 week operating plan for running a **controlled, founder-onboarded, no-real-payment** pilot of IdaraWorks with **1–2 arm's-length GCC industrial SMBs**. It is the umbrella that sequences the existing pilot playbook (`00`–`08`), the role/admin guides (`../guides/*`), and the operational runbooks (`../../runbooks/*`) into a phased schedule with a support-level and an exit check per phase. It does **not** restate the credential-entry mechanics of creating an account/org/invite — those live in [`00-pilot-org-setup.md`](00-pilot-org-setup.md) and [`02-roles-invitations.md`](02-roles-invitations.md); this plan orchestrates and gates them.
>
> **Product.** IdaraWorks — an **AI-configured Operations Management System** (not an ERP) for GCC project-based industrial SMBs. Arabic + English, RTL, mobile-first.
> **Deployment.** `https://idaraworks.vercel.app` · Supabase Postgres (Seoul, `ap-northeast-2`) · hosted DB at migrations `0000–0064` (next is `0065`) · deployed + CI-green at commit **`97985e1`** · production org baseline = **[Alpha Marine, TESTING]**.
> **Premise.** This pilot moves **no real money.** Every seam that would touch funds, a card, or a government tax authority is **disabled in production by design** (`isProd()` guard) and stays that way. The pilot runs the full governed operational→money→commercial loop on the tenant's own books with zero financial risk. Real charging is a later, owner-provisioned activation step (D1/D3), out of scope here.

---

## §0. Capability status

Every capability below is classified against the **authoritative production config** (the env vars actually set on the Vercel `idaraworks` project). This is the single source of truth for "can I promise the pilot this?" — grounded in [`../../runbooks/credential-disabled-operations.md`](../../runbooks/credential-disabled-operations.md), [`05-operational-billing-readiness.md`](05-operational-billing-readiness.md), and [`../MVP-READINESS-REPORT.md`](../MVP-READINESS-REPORT.md).

### Legend

| Code | Class | Meaning |
| --- | --- | --- |
| ✅ | **production-operational** | Live in prod on the current config; nothing to provision; the deterministic path *is* the product. |
| 🛠 | **production-operational-through-a-manual-process** | Correct and available, but a step that would be automated is run **on-demand / operator-run** for the pilot. |
| 🔑 | **credential-gated** | Disabled or degraded until the owner supplies a named secret. A working fallback covers the pilot. |
| 💳 | **D1-gated** | Needs incorporation + merchant of record (D1) / certified partner (D4) before it can move real money or submit to a tax authority. |
| 🛡 | **intentionally-disabled-for-safety** | Deliberately OFF in prod via `isProd()` / policy so a no-payment pilot cannot move funds or accept an unscanned upload. |
| 📦 | **deferred-beyond-MVP** | Not built for the MVP; documented with rationale. |

### The production config these classes are grounded in

**SET in Vercel (Production)** — the app serves traffic on exactly these: `APP_ENV=prod` · `NEXT_PUBLIC_SUPABASE_URL` · `NEXT_PUBLIC_SUPABASE_ANON_KEY` · `DATABASE_URL` (Supavisor pooler, password-redacted) · `APP_DB_PASSWORD` · `STORAGE_S3_ACCESS_KEY_ID` / `STORAGE_S3_SECRET_ACCESS_KEY` / `STORAGE_S3_ENDPOINT` / `STORAGE_S3_REGION`.

**Deliberately NOT in the Vercel runtime:** `SUPABASE_SERVICE_ROLE_KEY` and `DIRECT_URL`. These live **only on the operator workstation** that runs migrations / storage setup (`pnpm db:migrate`, `pnpm storage:setup`) — never in the serving env (phase2/10 #1). The app derives its pooled connection as `app_user` + `APP_DB_PASSWORD`; it never needs the service role or the direct URL to serve.

**NOT set ⇒ that seam is disabled/degraded in prod** (each has a working fallback, named below): `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` · `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` · `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` · `RESEND_API_KEY`/`EMAIL_FROM` · `OAUTH_ENABLED` · `SCAN_PROVIDER` · `AI_NARRATION_PROVIDER` · `BILLING_PROVIDER` · `EINVOICE_PROVIDER`.

> **The two hard, always-on dependencies** are `db` and `storage` — the only two that can 503 `/api/health`. Everything in the NOT-SET list degrades gracefully or defers work; none of it takes the app down. `/api/health` reports `inngest: unconfigured` as an *explicit, expected* status, never an unexplained failure.

### Capability table

| Capability | Class | State in the pilot | Fallback / how to enable |
| --- | --- | --- | --- |
| **Authentication** (email+password ≥10 chars, phone-OTP, TOTP MFA) | ✅ | Live. MFA org-enforceable; sensitive actions redirect to `/mfa`. | — |
| **Invitations — create + accept** | ✅ | Live; single-use token, 7-day expiry, audited `membership_invite.create` → `membership.join`. | — |
| **Invitation email *delivery*** | 🔑 | `RESEND_API_KEY` unset ⇒ email not sent; the accept link is **surfaced once in the Members UI** to hand over out-of-band. | Set `RESEND_API_KEY` (+ `EMAIL_FROM`) in Vercel prod. |
| **OAuth (Google/Microsoft) sign-in** | 🔑 | `OAUTH_ENABLED` unset ⇒ buttons hidden; email+password/OTP/TOTP are the auth methods. | Set `OAUTH_ENABLED=true` + configure providers in Supabase. |
| **Org onboarding** (guided AI intake **and** manual fallback) | ✅ | Live and deterministic; the guided proposal needs **no AI credentials** — the grounded validator is the product. F-28 caps auto-approve at 2× template default. | — |
| **Templates** (`boatbuilding_marine_v1` = template #1) + **terminology** (16 keys, EN/AR + gender) | ✅ | Live; template #1 installs 11 stages, 9 job presets, categories, calendars, marine terms. | Templates **#2–3** and the `terminology.overrides` onboarding handler → 📦 (frozen: no universal engine before a 2nd paying vertical). |
| **Operational workflows** — jobs, stages, tasks, crew, U7 progress, **daily reports** (draft/submit/review, cost wall, exactly-once), **attendance** (labour lines *are* attendance), **issues** | ✅ | Live; every sync write commits in-request. Cost wall: a foreman freezes labour cost via `SECURITY DEFINER` **without ever reading it**. | — |
| **Purchasing** (MR → PO → GRN, partial receipts) + **the unified approval engine** (sole-writer, self-approval guard, escalation, per-subject redaction) | ✅ | Live. Safe default: no rule ⇒ route to Owner, never auto-approve. | Mid-pilot **rule edits** → 🛠 (no self-service rule editor; operator re-runs onboarding apply / `createApprovalRule`). Nightly `approval_stuck` sweep → 🔑 (Inngest); the **event-lane** E-03 on evaluate still fires. |
| **Costing engine** (sole-writer rollup, dedup, both VAT bases, redaction walls) + **exception engine** (E-01…E-13) | ✅ | Live; costing reproduces the Najolatech golden (ex-labour `290000` / total `395000`). Event-lane exceptions (E-03/E-07/E-08) fire live. | **Cost-rollup cache invalidation** + the **nightly** exception sweep (E-01/02/05/06/09/10/13) → 🔑/🛠 (Inngest dormant; run `runOrgNightly()` / rollup invalidators on-demand — [`../../runbooks/queue-worker-recovery.md`](../../runbooks/queue-worker-recovery.md)). |
| **Quotes → invoices → payments → AR + credit notes** (tenant billing its own customers) | ✅ | Live; bigint minor units, per-line VAT, base-currency freeze at issuance, issued invoices immutable (corrections = credit notes). | — |
| **Tenant VAT** (`finance.vat_registered` + per-line `vat_rate` + `is_export` zero-rating) | ✅ | Live, org-configured; same flag drives the costing VAT basis so the two never disagree. | **PB-3** accountant sign-off of the chosen base is an [OWNER ACTION] before issuing real customer invoices. |
| **Customer updates** (share surface at billing milestones) | ✅ | Live; deterministic. | Outbound *email* of an update → 🔑 (Resend). |
| **Owner digest** (deterministic morning digest; thirteen-questions answered from Today) | ✅ | Live on **pull** — computed from tenant data whenever Today loads; no AI. | Scheduled **nightly** digest run/delivery → 🔑 (Inngest cron dormant). |
| **Data exports** (self-service CSV, 8 entities) | ✅ | Live; `data.export` = owner/admin/accounts; paged (no 1,000-row cap), redaction-aware, formula-injection-safe. Reads/exports **never** blocked by entitlements or a read-only state (FR-9). | — |
| **Subscriptions + usage enforcement** (state machine, entitlements, `usage_event` metering, read-only states) | ✅ | Live and governed with **no real money**. Metering idempotent + period-aware; read-only enforced at the `command()` chokepoint (S10 fix); FR-9 blocks ADDs, never reads. | Limits are **placeholder** tier values (D3). Lifecycle/dunning **cron** → 🔑 (Inngest; dormant is *desirable* so trials can't auto-expire an org mid-pilot). |
| **Support impersonation** | ✅ | Live; consent-gated or break-glass, time-bounded, RLS-scoped as `app_user`, **dual-logged to the tenant's own `audit_log`**, persistent banner. | — |
| **Background workers + Inngest** (24 functions, 5 crons) | 🔑 | `INNGEST_*` unset ⇒ `/api/inngest` returns explicit `503 inngest_unconfigured`; fleet dormant; every domain event **queues durably to the outbox** (at-least-once, nothing lost). | 🛠 Run the work on-demand: `relayOutbox()`, `sweepLifecycle()`, `dispatchNightly()`/`runOrgNightly()`, `pruneRetention()`. Enable: [`../../runbooks/inngest-provisioning.md`](../../runbooks/inngest-provisioning.md). Never `INNGEST_DEV=1` in prod. |
| **PDF generation** (LPO / invoice) | 🔑 🛠 | Bilingual, bidi Arabic-primary **HTML is composed every time** (bidi-snapshot-tested); a real reviewable PDF is produced by the demo path via bundled Chromium. No **stored** `financial_doc` PDF (doubly gated on a render runtime **and** Inngest). | Share the on-screen document; do **not** promise a downloadable stored PDF. Enable: render runtime + Inngest (activation only). |
| **Email + messaging** | 🔑 | `RESEND_API_KEY` unset ⇒ email is a dev/log sink; **in-app notifications work fully** (persisted in-transaction, redacted bodies). No SMS/push transport wired. | Set `RESEND_API_KEY` (+ `EMAIL_FROM`). |
| **Sentry (error capture)** | 🔑 | `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` unset ⇒ clean no-op. **Structured pino logs** (`request_id`/`org_id`/`user_id`, echoed as `x-request-id`) are the pilot's observability. | Set `SENTRY_DSN`: [`../../runbooks/sentry-provisioning.md`](../../runbooks/sentry-provisioning.md). Watch `/api/health` `queue.dead_lettered` yourself meanwhile. |
| **Upstash / Redis (rate limits)** | 🔑 | `UPSTASH_*` unset ⇒ **in-memory sliding-window** limiter: every limited surface still bounded, but **per-instance**, resets on deploy. Adequate for a controlled pilot. | Set `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`. **Required before any adversarial exposure** of `share`/`webhook`/`health`. |
| **AI narration** | 🛡 / 🔑 | `AI_NARRATION_PROVIDER` unset **and** disabled via `isProd()` ⇒ narration off. The **deterministic digest IS the shipped product**; narration is only an optional wording layer. No tenant free-text ever leaves the system. | Set `AI_NARRATION_PROVIDER` + creds; a numbers-subset validator constrains any real output. |
| **Payment provider (platform billing)** | 💳 🛡 | `BILLING_PROVIDER` unset ⇒ **disabled** adapter via `isProd()`; `startCheckout`/portal throw `BillingProviderDisabledError`; `/api/billing/webhook` `verifySignature()` → `false` (accepts nothing). No card data ever touched. Subscription page shows **"commercial activation unavailable."** | **D1** (entity + merchant of record) + a real adapter + secrets + price IDs. Pure activation — no schema/logic change. |
| **E-invoicing (ZATCA / gov submission)** | 💳 🛡 | `EINVOICE_PROVIDER` unset ⇒ **disabled** via `isProd()`; clearance is a recorded no-op. Invoices are valid business documents without a clearance id. | **D4** certified partner + credentials. Do not represent pilot invoices as government-cleared. |
| **Malware scanning / document uploads** | 🛡 / 🔑 | `SCAN_PROVIDER` unset ⇒ document-upload path **disabled in prod for safety**. **Image** uploads work: re-encoded + EXIF-stripped. | Set `SCAN_PROVIDER` to enable document (non-image) uploads. |
| **Backups + recovery** | 🛠 | RPO ≤ 1h / RTO ≤ 4h objectives published; restore + incident drills are **operator-run** per runbook. First live restore drill is a **pre-pilot [OWNER ACTION]**. | Confirm Supabase PITR add-on + a second-provider nightly backup. The automated backup **monitor** is a seam not yet built → owner confirms manually (📦 for the automation). |
| **Per-tenant telemetry dashboards** | 📦 | Pilot telemetry MVP = **audit trail + `usage_event` + `/api/health`**, queried per-org weekly. | Deferred; needs an owner-provisioned metrics store. |
| **`paused` billing state · cross-instance entitlement push-invalidation · table partitioning** | 📦 | Deferred with rationale (60s TTL backstop covers entitlement staleness; partitioning is volume-triggered). | Not needed for a controlled pilot. |

**Net read:** the entire operational→money→commercial loop is ✅ or 🛠 for a no-payment pilot. The only things a pilot user cannot get are a *stored downloadable* PDF, *emailed* invites/notifications, *AI-narrated* prose over the digest, *real charging*, and *government e-invoice clearance* — each with a stated fallback or a later activation.

---

## The 15-phase plan

### Founder-support scale

The pilot design is **founder-watched, not founder-driven** (`07` §1): if it needs the founder's hands to run, onboarding has failed. But a controlled pilot still starts high-touch on the steps only the founder *can* do (platform credentials, platform-staff actions) and hands off fast. Each phase carries a level:

- **L3 · Founder-led** — only the founder has the access (platform env vars, `platform_staff`, on-demand worker runs). The founder does it.
- **L2 · Founder-guided** — customer at the keyboard, founder side-by-side coaching.
- **L1 · Founder-watched** — customer does it unaided; founder observes and takes notes. **This is the measured success posture.**
- **L0 · Self-serve** — customer runs it alone; founder on-call via the agreed support channel.

> **Reconciling the two mandates.** The brief is a *founder-onboarded* pilot; the success test (`07` §2, M-live pass) wants the **owner to answer the thirteen questions unaided**. Resolve it by graduating support: the founder operates platform-level controls (L3) and co-drives the first onboarding (L2), then deliberately steps back to L1/L0 so the "owner runs on Today unaided" signal is real and measurable.

### Timeline at a glance (2–4 weeks per org)

| Week | Phases |
| --- | --- |
| **Pre-week** | 1 Pre-launch |
| **Week 1** | 2 Admin onboarding · 3 User onboarding · 4 Initial imports · 5 First live project |
| **Week 2** | 6 Planning+assignment · 7 Daily reporting · 8 Purchasing+approvals |
| **Week 3** | 9 Receiving+costing · 10 Quotation+invoicing · 11 Customer updates · 12 Owner digest |
| **Ongoing / Week 4** | 13 Subscription+usage monitoring · 14 Weekly reviews · 15 Final assessment |

---

### Phase 1 — Pre-launch (platform readiness)

**Goal.** Prove the platform is safe to onboard a real customer onto, and that every disabled seam is disabled *on purpose* and reported explicitly.

**Steps.**
1. Walk the **launch-criteria checklist** as a ceremony (two people, open each named artifact): [`06-launch-criteria-checklist.md`](06-launch-criteria-checklist.md). Sections G (regression + build gates) and the GREEN rows are provable from the repo at commit `97985e1`.
2. Confirm the four platform prerequisites in [`00-pilot-org-setup.md`](00-pilot-org-setup.md) §0: `GET /api/health` → 200 with `db` + `storage` healthy; DB at `0064`; storage buckets set up; runtime env present. Migrations/storage-setup run from the **operator workstation** (which holds `DIRECT_URL` + `SUPABASE_SERVICE_ROLE_KEY` locally) — never from Vercel.
3. Run `pnpm smoke:prod -- https://idaraworks.vercel.app` (asserts routing, auth gate, health dependencies, **`inngest` explicit unconfigured**, no dead-letters, `EXPECTED_COMMIT` match).
4. Verify the safety posture from [`05-operational-billing-readiness.md`](05-operational-billing-readiness.md) §7: `BILLING_PROVIDER` unset/`disabled` (never `fake`); subscription page shows **"commercial activation unavailable"**; a POST to `/api/billing/webhook` is rejected; e-invoice resolves `disabled`. **If a live Buy button ever shows in prod, stop — the `isProd()` guard is wrong.**
5. Complete the blocking **[OWNER ACTION]s** from [`08-owner-action-checklist.md`](08-owner-action-checklist.md) §A: external pen test (**criticals = 0, hard gate, no waiver**); DPA/PDPL lawful-transfer basis **before any KSA org holding ID docs**; Arabic native-reviewer sign-off; **first restore drill** ([`../../runbooks/restore-drill.md`](../../runbooks/restore-drill.md)) + **incident tabletop** ([`../../runbooks/incident-response.md`](../../runbooks/incident-response.md)) with evidence filed; confirm PITR add-on. Decide whether to provision **Inngest** now ([`../../runbooks/inngest-provisioning.md`](../../runbooks/inngest-provisioning.md)) or run the crons on-demand.
6. Read [`../../runbooks/credential-disabled-operations.md`](../../runbooks/credential-disabled-operations.md) end-to-end so the founder can explain every degraded seam to the customer before it surprises anyone.

**Docs/runbooks.** `06`, `00` §0, `08` §A; runbooks `deployment-and-rollback`, `restore-drill`, `incident-response`, `backup-monitoring`, `credential-disabled-operations`, `inngest-provisioning` (optional); `pnpm smoke:prod`.

**Founder support.** **L3.** Only the founder holds the credentials, `platform_staff` role, and drill responsibility.

**Exit check.** `06` signed **GO** (pen-test criticals = 0, restore drill filed); `/api/health` green; smoke 18/18 at `97985e1`; billing/e-invoice confirmed disabled.

---

### Phase 2 — Admin onboarding (org + configuration)

**Goal.** Take the pilot from "no account" to a configured workspace with template #1 installed and terminology set — a cold org in under ~30 minutes.

**Steps.** Follow [`00-pilot-org-setup.md`](00-pilot-org-setup.md) §1–§3 and the tickable [`01-onboarding-template-checklist.md`](01-onboarding-template-checklist.md) Stages 1–3; the pilot org's owner drives account/org creation (this plan orchestrates and verifies, it does not restate the credential-entry steps). Configuration goes through **Path A (guided AI onboarding)** — recommended, deterministic, no AI creds — or **Path B (manual template install)**; both call the same governed `installTemplate` pipeline. Verify the bootstrap: owner is a member, 7 roles exist, plan `growth` / state `trialing`. Set terminology only if the marine defaults don't fit (usually skip). Confirm auto-approve numbers were **accepted**, not F-28-rejected.

**Docs/runbooks.** `00` §1–3, `01` Stages 1–3, [`../guides/admin-guide.md`](../guides/admin-guide.md) §4, §11.

**Founder support.** **L2.** Founder side-by-side; the owner does the "how does your business operate?" intake so the config reflects *their* business, not the founder's assumptions.

**Exit check.** Configuration shows `boatbuilding_marine_v1 v1`; 9 presets + 11 stages present; a preset yields a hull reference like `24C-001`; every change is an audited, undoable `config_revision`.

---

### Phase 3 — User onboarding (roles + invitations)

**Goal.** The right people in the right of the **7 roles**, with the money walls correct.

**Steps.** Follow [`02-roles-invitations.md`](02-roles-invitations.md) and [`01`](01-onboarding-template-checklist.md) Stage 5. Assign per the suggested map: owner→`owner`, ops lead→`admin`, workshop manager→`manager` (labelled *Workshop Manager*, no cost/price), foreman(en)→`foreman` (field seat, free, phone-first), buyer→`procurement`, accountant→`accounts`, stakeholders→`viewer` (free). **[OWNER ACTION]:** with `RESEND_API_KEY` unset, hand each surfaced `/invite/<token>` link over out-of-band. Invite foremen/viewers freely — they never count against a paid cap; track full-user growth manually (the invite form does not hard-stop at the seat cap in the MVP).

**Docs/runbooks.** `02`, `01` Stage 5, [`../guides/role-guides.md`](../guides/role-guides.md).

**Founder support.** **L2** for the first invites (explain the seat economics + the cost/price wall), tapering to **L1**.

**Exit check.** A second admin exists (continuity); at least one invitee accepted and reached the org; foreman confirmed to see **no money anywhere**; MFA available on `/account`.

---

### Phase 4 — Initial imports (masters)

**Goal.** Load the real customers, suppliers, employees, and catalog items.

**Steps.** Follow [`03-initial-imports.md`](03-initial-imports.md). Order that avoids errors: confirm item **categories** exist (from template #1) → import **customers** → **employees** → add **suppliers** (manual form; not in the importer) → import **items** (needs categories). Money is in **minor units**. Remember **employees ≠ users** — importing the workforce consumes no seats and sends no invites. The importer is re-runnable and safe against double-submit. Spot-check a record on each list page.

**Docs/runbooks.** `03`, `00` §4, [`../guides/admin-guide.md`](../guides/admin-guide.md) §4.2/§7.

**Founder support.** **L2** (CSV shape, minor units, category dependency), then **L1**.

**Exit check.** Each list page shows the new records; a round-trip export (`GET /api/o/<orgId>/export?entity=customers`) confirms tenant-scoped persistence with money redacted to the caller's privilege.

---

### Phase 5 — First live project (the parity gate)

**Goal.** Prove the configured workspace produces a correctly-costed job — the acceptance gate that "configured correctly" means.

**Steps.** Follow [`00`](00-pilot-org-setup.md) §6 and [`01`](01-onboarding-template-checklist.md) Stage 6. Create the first job from a preset (hull number allocated atomically); optionally file a first daily report to confirm the heartbeat. **Costing parity:** the onboarded config must reproduce the S5 golden — **ex-labour `290000`, total `395000`** to the minor unit. A divergence means the template install / expense-category costing mappings are wrong; re-check before proceeding.

**Docs/runbooks.** `00` §6, `01` Stage 6 + "S8 parity gate", `06` §C.

**Founder support.** **L1.** The owner should create the first job unaided; the founder watches.

**Exit check.** First job created with a valid hull reference; parity numbers match (or the config is corrected until they do); audit log shows the full setup trail (org → template → revisions → invites → imports → first job).

---

### Phase 6 — Planning + assignment

**Goal.** The workshop manager runs the week: stages moved, crew assigned, the week plan populated.

**Steps.** Manager works the **Work** surfaces (Jobs, Week, crew) per [`../guides/role-guides.md`](../guides/role-guides.md) (Manager) and the [`../guides/quick-start-en.md`](../guides/quick-start-en.md) / [`../guides/quick-start-ar.md`](../guides/quick-start-ar.md). Assign foremen to jobs (foremen act **only** on assigned jobs). Confirm the **holiday calendar** is set for the org's country ([`04-approval-reporting-config.md`](04-approval-reporting-config.md) §4.4/§5.2) — it is the one org-editable lever that changes exception timing and prevents Eid storms.

**Docs/runbooks.** `role-guides` (Manager/Foreman), `quick-start-en`/`-ar`, `04` §4–5.

**Founder support.** **L1.**

**Exit check.** Week view shows planned stages; at least one foreman is assigned and sees the job on their field Today; holiday calendar confirmed for the pilot country.

---

### Phase 7 — Daily reporting (the heartbeat)

**Goal.** Foremen filing daily reports **from their own phones** — the atomic input the whole system depends on.

**Steps.** Foremen file the day's report on an assigned job: stage worked, labour **hours** (normal + OT), materials, photos — per [`../guides/role-guides.md`](../guides/role-guides.md) (Foreman) and the quick-starts. Labour lines **are attendance** (one write, three reads). The submit is **exactly-once** across offline retries (stable idempotency key). Managers review (`submitted → reviewed | returned`); a reviewed report is immutable. Confirm the **cost wall** in the demo: the foreman freezes labour cost without ever reading it ([`04`](04-approval-reporting-config.md) §4.2).

**Docs/runbooks.** `role-guides` (Foreman/Manager), `quick-start-*`, `04` §4.

**Founder support.** **L1 → L0.** This is the make-or-break adoption signal; the founder should be watching whether crews self-serve, not entering data for them.

**Exit check.** ≥ 1 report/day per active job from the foreman's own device; a manager has reviewed one; airplane-mode submit + reconnect produces exactly one report.

---

### Phase 8 — Purchasing + approvals

**Goal.** Material needs flow through the one approval engine to orders, with the routing the pilot chose.

**Steps.** Install the pilot's approval policy **once** at onboarding per [`04`](04-approval-reporting-config.md) §3.3 (e.g. MR `always → manager`; PO `amount_gte → owner/admin`; `quote_send always → owner/admin`; expense/payment `none` initially). Procurement raises MRs, converts approved MRs to POs, receives goods (GRNs) — [`../guides/role-guides.md`](../guides/role-guides.md) (Procurement). Verify the safety guarantees: no-rule ⇒ routes to Owner (never auto-approve); the self-approval guard escalates one role up; inbox amounts are redacted per subject type; a rejection requires a reason. **Mid-pilot rule changes are an operator task** (🛠 — no self-service editor); flag this to the owner up front.

**Docs/runbooks.** `04` §2–3, `role-guides` (Procurement/Manager).

**Founder support.** **L2** to set the policy once, then **L1** for day-to-day deciding.

**Exit check.** An MR → approval → PO → GRN cycle completes; the ambiguity guard rejects a second `always` on one subject; a foreman/viewer sees no amount on the inbox.

---

### Phase 9 — Receiving + costing

**Goal.** Received goods and expenses roll into live per-job costing and surface the right exceptions.

**Steps.** Record GRNs (incl. partial receipts) and expenses (no-PO validation; void-with-reason). Confirm the costing page reflects inputs and that the money walls hold: Workshop Manager sees quantities/progress but labour cost + margin **blanked**; Accounts sees full figures. **Because Inngest is dormant**, cost-rollup cache invalidation and the nightly exception sweep (E-05 margin drift, E-06 late PO, E-08 unusual expense on the nightly lane) do not run automatically — the founder runs them **on-demand** (`runOrgNightly()` / rollup invalidators) per [`../../runbooks/queue-worker-recovery.md`](../../runbooks/queue-worker-recovery.md) and [`../../runbooks/credential-disabled-operations.md`](../../runbooks/credential-disabled-operations.md) §1, or provisions Inngest to make them live.

**Docs/runbooks.** `04` §5, `credential-disabled-operations` §1, `queue-worker-recovery`, `role-guides` (Accounts/Manager).

**Founder support.** **L3** for the on-demand worker runs (only the founder can run platform tasks), **L1** for the customer-facing costing/expense entry.

**Exit check.** > 80% of active jobs carry a populated cost rollup after a rollup run; an expense over a category median raises E-08; costing parity still holds; the cost wall verified for a manager vs accounts.

---

### Phase 10 — Quotation + invoicing (tenant's own books, no real charging)

**Goal.** A full quote → job → invoice → payment cycle on the pilot org's **own** customers — with platform billing untouched.

**Steps.** Draft a quote (management), send it (`quote_send` approval), issue an invoice, record a payment, watch AR age — per [`05-operational-billing-readiness.md`](05-operational-billing-readiness.md) §3.2 and [`../guides/role-guides.md`](../guides/role-guides.md) (Accounts). Confirm: **tenant invoicing is fully live** (the pilot org billing its customers is bookkeeping, not IdaraWorks charging anyone); VAT computes per line; an `is_export` line zero-rates; a non-registered org issues zero-VAT; issued invoices are immutable (corrections = credit notes). **E-invoice government submission stays disabled** — do not represent invoices as cleared. **PDF is HTML-only** — share the on-screen document, not a stored download. Set `finance.vat_registered` to the **PB-3** accountant decision before real invoices.

**Docs/runbooks.** `05` §1–3, `role-guides` (Accounts), `credential-disabled-operations` §2–3.

**Founder support.** **L2** (VAT flag + the disabled-seam expectations), then **L1**.

**Exit check.** One quote→job→invoice→payment cycle closes in-system; AR outstanding = sum of aged buckets and never negative; e-invoice resolves `disabled`; VAT matches the accountant's base.

---

### Phase 11 — Customer updates

**Goal.** The pilot org sends progress updates to its customers at billing milestones.

**Steps.** Use the **Customer updates** surface ([`../guides/admin-guide.md`](../guides/admin-guide.md) §2, Reports group). The share surface is deterministic and live; the digest/Today flag "active jobs at a billing milestone with no update sent" (thirteen-questions Q11). Outbound **email** of an update is 🔑 (Resend) — for the pilot, the update is shared via the surface / link rather than an automated email blast.

**Docs/runbooks.** `admin-guide` §2, `06` §B (Q11).

**Founder support.** **L1.**

**Exit check.** At least one customer update produced at a milestone; the "awaiting update" signal clears on Today after it is sent.

---

### Phase 12 — Owner digest (the thirteen-questions live pass)

**Goal.** The owner runs the business from **Today** and answers the thirteen operational questions off the deterministic digest — unaided.

**Steps.** Walk [`06`](06-launch-criteria-checklist.md) §B live: the owner reads each of Q1–Q13 off Today/the digest on seeded, real pilot data, unprompted. The digest is deterministic (no AI dependency — narration is 🛡 disabled and irrelevant). Confirm the **freshness discipline**: a stale card ("no report from Hull 24C-003 since Tuesday") reads as a *signal*, not a blank.

**Docs/runbooks.** `06` §A6 + §B, [`../guides/role-guides.md`](../guides/role-guides.md) (Owner), S7 evidence.

**Founder support.** **L1 — the measured moment.** The owner answers unaided; the founder only observes and scores 13/13.

**Exit check.** Owner answers all thirteen questions from Today without help; opens Today as a daily habit (leading indicator for M7).

---

### Phase 13 — Subscription + usage monitoring (no real payment)

**Goal.** Watch the commercial layer run safely with no money moving, and place the pilot org in the right billing state.

**Steps.** Keep the pilot org in **`internal_pilot`** (no trial deadline) or `trialing` with `provider = null` — the reference posture of Alpha Marine / TESTING ([`05`](05-operational-billing-readiness.md) §6.2). Billing state is set **only** via the platform path (`app.advance_subscription`, platform-staff/task-gated) — never a tenant action. Metering + entitlements run live but enforce **placeholder** limits (D3); FR-9 guarantees reads/exports are never blocked. Do **not** flip `is_placeholder=false`, load real price IDs, or set `BILLING_PROVIDER` — that is D1/D3 and out of scope. Track full-user growth manually.

**Docs/runbooks.** `05` §4–6, [`../../runbooks/impersonation-history.md`](../../runbooks/impersonation-history.md) (support sessions), `07` §3 (measurement plumbing = audit trail + `usage_event` + `/api/health`).

**Founder support.** **L3.** Subscription state + platform billing are platform-staff-only by design.

**Exit check.** Pilot org sits `internal_pilot`/`trialing`, `provider=null`, prices `is_placeholder=true`; metering records once per idempotent event; an over-limit ADD is blocked while a read + export still work (verify on a scratch org, never a live pilot org).

---

### Phase 14 — Weekly reviews

**Goal.** A weekly per-company health read that drives continue / intervene / kill-signal decisions.

**Steps.** Run the weekly cadence from [`07-pilot-success-exit-criteria.md`](07-pilot-success-exit-criteria.md) §7: pull M1–M4, M7–M9 from the per-org query set (audit trail + `usage_event`) into the tracking sheet; run the M9 "WhatsApp test" survey; review open incidents and the support-impersonation log. Execute the **one mid-pilot reconfiguration** through the revision system to prove the config pipeline survives a changing business (undoable, no data loss). Any direct support data access follows [`../../runbooks/break-glass.md`](../../runbooks/break-glass.md) and is tenant-audited; incidents follow [`../../runbooks/incident-response.md`](../../runbooks/incident-response.md).

**Docs/runbooks.** `07` §3/§5/§7, runbooks `incident-response`, `break-glass`, `impersonation-history`, `exports`.

**Founder support.** **L1** for the customer's usage; **L3** for any impersonation/break-glass access.

**Exit check.** Weekly metrics recorded for each org; the mid-pilot reconfig applied and undoable; kill-signals (reports stall, dead Today, money loop never closes, freshness collapse) explicitly checked, not assumed.

---

### Phase 15 — Final assessment

**Goal.** Decide the pilot's outcome against the P2 gate, and honor uninstallable trust either way.

**Steps.** Apply the cohort decision framework in [`07`](07-pilot-success-exit-criteria.md) §6 — **GRADUATE / ITERATE / STOP**. Note the honest scope of a 1–2 org controlled pilot: the *cohort* conversion gate (≥ 5 of 8, ≥ 1 non-marine) and the **month-2 real-payment conversion signal** cannot be read here because charging is D1-gated and off — record which signals this controlled pilot *can* produce (operational adoption, thirteen-questions live pass, loop completion, config-pipeline survival) versus which require the later paying cohort. Whatever the outcome, deliver **uninstallable trust**: a full self-service export per org (`/api/o/<orgId>/export`, [`../../runbooks/exports.md`](../../runbooks/exports.md)) and a clean close per [`../../runbooks/cancellation.md`](../../runbooks/cancellation.md) / [`../../runbooks/data-cleanup.md`](../../runbooks/data-cleanup.md) / [`../../runbooks/retention.md`](../../runbooks/retention.md); document kill reasons for a future pivot. **Alpha Marine / TESTING are never touched** by pilot close-out.

**Docs/runbooks.** `07` §4–6, runbooks `exports`, `cancellation`, `data-cleanup`, `retention`, `legal-hold`, `access-revocation`.

**Founder support.** **L3** (the founder/owner decides on the data; export + closure are platform-run).

**Exit check.** A written GRADUATE/ITERATE/STOP decision with its rationale; every pilot org has a filed full export; closure honored without touching protected orgs.

---

## Owner-action gates carried through the pilot

From [`08-owner-action-checklist.md`](08-owner-action-checklist.md). **None of the money items block a no-payment pilot** — they gate real charging, which is out of scope here.

| Gate | Blocks the controlled pilot? | Blocks real money / full go-live? |
| --- | :--: | :--: |
| Pen-test criticals = 0 (hard, no waiver) | **Yes** | Yes |
| DPA/PDPL + KSA lawful-transfer basis (before any KSA ID docs) | **Yes (KSA)** | Yes |
| Arabic native-reviewer sign-off | **Yes** | Yes |
| First restore drill + incident tabletop (evidence filed) | **Yes** | Yes |
| Confirm PITR add-on + second-provider backup | **Yes** | Yes |
| Inngest keys (live crons) | No — dormant is fine; run on-demand | — |
| Sentry / Upstash / Resend / render runtime | No — fallbacks cover the pilot | Before scale/adversarial exposure |
| **D1** entity + merchant of record | No | **Yes** |
| **D3** pricing numbers + tier limit values | No | **Yes** |
| Tax mechanism + **PB-3** VAT sign-off | No (set the flag) | Gates real customer invoices |
| **D4** certified e-invoice partner | No | Gates government clearance |

---

## Guardrails (do-not-cross for this pilot)

- **No real payment processing.** Keep `BILLING_PROVIDER` disabled, `EINVOICE_PROVIDER` disabled, `plan_price` rows `is_placeholder=true`, and the pilot org `provider=null`. Do not activate D1.
- **Never handle secret values.** This plan names env vars and says where to set them (Vercel prod / Supabase / operator workstation) — it never carries a value. Rotate the DB/app passwords before pilots ([`08`](08-owner-action-checklist.md) §D) and keep `SUPABASE_SERVICE_ROLE_KEY` / `DIRECT_URL` off the Vercel runtime.
- **Protected orgs are untouchable.** Alpha Marine and TESTING are never read for deletion or written during any pilot activity.
- **Read-only-state tests run on scratch orgs only**, never on a live pilot org.
- **Set expectations honestly:** no stored downloadable PDF, no emailed invites/notifications (hand links over), no AI narration, no government-cleared invoices — each has a stated fallback and is the *intended* pilot posture, not a fault.

---

*Traceability:* capability status grounded in the authoritative Vercel config + [`../../runbooks/credential-disabled-operations.md`](../../runbooks/credential-disabled-operations.md), [`05-operational-billing-readiness.md`](05-operational-billing-readiness.md), and [`../MVP-READINESS-REPORT.md`](../MVP-READINESS-REPORT.md). Phases compose the pilot playbook [`00`](00-pilot-org-setup.md)–[`08`](08-owner-action-checklist.md), the guides [`../guides/admin-guide.md`](../guides/admin-guide.md) / [`../guides/role-guides.md`](../guides/role-guides.md) / [`../guides/quick-start-en.md`](../guides/quick-start-en.md) / [`../guides/quick-start-ar.md`](../guides/quick-start-ar.md), and the runbooks in [`../../runbooks/`](../../runbooks/). Deployed commit `97985e1`, migrations `0000–0064`, baseline orgs [Alpha Marine, TESTING].
