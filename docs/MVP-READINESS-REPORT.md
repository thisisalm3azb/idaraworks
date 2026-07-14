# IdaraWorks — MVP Readiness Report (post-S11)

**Prepared:** 2026-07-14 · **Deployed commit:** the S11-close commit (CI-green, confirmed by prod
health + prod smoke) · **Hosted DB:** Seoul, migrations `0000–0064` · **Baseline:** exactly
[Alpha Marine `d22b2098…`, TESTING `9fcaa697…`].

IdaraWorks is an **AI-configured Operations Management System** (not an ERP) for GCC project-based
industrial SMBs — Arabic + English, RTL, mobile-first. Twelve slices S0–S11 are built, deployed, and
verified: platform foundation, config/onboarding, plan & assign, report, supply & approve, measure,
bill, improve, AI onboarding, commercial wiring, hardening, and pilot readiness.

## Templates actually included

- **Template #1 — Boatbuilding / Marine (`boatbuilding_marine_v1`)**: 11 stages (Mould Prep → Delivery),
  9 job presets (13ft Skiff … 20m Catamaran), the full category/role/holiday-calendar set, 60/40
  billing points. It is template #1 + the Najolatech test-bench; **no template #2–3** (frozen: no
  universal engine before a second paying vertical).

## Capability classification

### Production-operational now
Multi-tenant platform (RLS second wall, per-request GUC, NOBYPASSRLS, no DELETE grants); auth (email+
password, phone-OTP, TOTP MFA); config pipeline + terminology + i18n (en/ar/RTL) + a language switcher;
masters; jobs + stages + tasks + crew + U7 progress; daily reports (draft/submit/review, cost wall,
attendance, issues, exactly-once); the unified approval engine + supply (MR/PO/GRN); the costing engine
(both VAT bases, dedup, redaction walls) + the exception engine (E-01..E-13); the Today screens; the
money loop (quotes → jobs → invoices → payments → AR + credit notes); the deterministic morning digest +
customer-update share surface; AI-onboarding as a deterministic grounded validator; the commercial layer
(subscription state machine, entitlements + usage metering, consent-gated support impersonation); and
the S10 hardening (prod-provider guards, DEFINER guards, concurrency backstops, per-org fault isolation,
retention pruning, self-service export, egress caching). All governed, all live.

### Production-operational through a manual process
The nightly workers (exception sweep, cost-rollup invalidation, lifecycle/dunning, retention prune) run
**on demand / in tests** and queue durably to the outbox until Inngest is provisioned; the drills
(restore, incident tabletop, break-glass, backup verification, staff-access, recycle-bin/closure) are
operator-run per their runbooks; the LPO/invoice PDF renders via the queued Chromium seam once the PDF
runtime is provisioned.

### Credential-gated (owner supplies secrets — never in repo/logs/chat)
Inngest Cloud keys (turn the worker fleet + all crons live); Sentry DSN; Upstash (durable rate limits);
the PDF render runtime; OAuth provider config + `OAUTH_ENABLED`; the document malware scanner; the
second-provider backup + PITR add-on + management-API token (live backup monitor); AI-provider
credentials + no-training contract terms.

### D1-gated (incorporation & merchant of record)
Real payment/e-invoice provider activation — real checkout, real charges, live webhooks, per-currency
price IDs. The full governed logic ships now behind provider seams **disabled in production**; enabling
is a pure activation step (secrets + a real adapter behind the same interface), no schema/logic change.

### Deferred beyond MVP (documented, with rationale)
Cross-instance entitlement-cache push-invalidation (Upstash-gated; 60s TTL backstop); `paused` billing
state; table partitioning (frozen, volume-triggered); per-tenant telemetry dashboards; `terminology.
overrides` onboarding handler; templates #2–3 and every scope-guard item (GL, payroll, stock, QC,
builders, public API, multi-company, white-label, WhatsApp, Worker archetype, etc.).

## Verification at MVP close

- **Gates:** format · lint 0 · typecheck · unit (312+) · build · **full integration + e2e + perf on
  GitHub CI green** · deployed commit confirmed by prod health + **18/18 prod smoke**.
- **Two-org synthetic pilot simulation** (`tooling/scripts/s11-pilot-sim.ts`, self-cleaning):
  **11/11 assertions PASS** across two isolated orgs (قوارب الخليج AE/AED + مراكب الشرق SA/SAR) —
  tenant isolation, cost redaction, the full operational→money loop, export + money-wall, subscription
  read-only states (FR-9: blocks ADDs never reads), and consent-gated support impersonation dual-logged
  to the tenant's own audit. 0 leftovers; Alpha Marine + TESTING untouched.
- **Adversarial reviews:** every slice S6–S11 passed an independent multi-lens adversarial review with
  per-finding verification; all confirmed material findings fixed with regression coverage (S10 alone:
  an 8-lens codebase audit + a 4-lens diff review that caught 5 self-introduced regressions).
- **Baseline:** production contains exactly [Alpha Marine, TESTING]; all synthetic pilot/test residue
  removed; protected orgs never read for deletion or written.

## Remaining owner actions (the pre-pilot checklist)

See `docs/pilot/08-owner-action-checklist.md` for the consolidated, categorised list. The blocking
subset for a **controlled pilot**: (1) **D1** entity + merchant of record — only if the pilot must take
real payment (a no-real-payment pilot does NOT need it); (2) **external pen test** executed with
criticals → 0; (3) **DPA / PDPL** lawful-transfer basis before any KSA pilot holding visa/ID docs;
(4) **Arabic native reviewer** sign-off; (5) the **first restore drill + incident tabletop** run with
evidence filed; (6) **Inngest keys** to make the nightly automation live (the engine runs on-demand
meanwhile). D3 pricing numbers, tax mechanism, Sentry/Upstash/PDF creds, and the name check are needed
before charging money / going fully live but not before a controlled no-payment pilot.

## Verdict

**IdaraWorks is READY for a controlled pilot** — a founder-onboarded, no-real-payment pilot with 1–2
arm's-length GCC industrial SMBs — subject to the owner completing items (2)–(6) above (the pen test,
DPA for KSA, Arabic review, the two drills, and Inngest for live automation). The product is
feature-complete across the operational→money→commercial loop, hardened, deployed, and demonstrated;
what remains is external validation and owner-provisioned credentials/legal, not engineering.
