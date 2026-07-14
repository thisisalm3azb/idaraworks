# Final Owner-Action Checklist (pre-pilot)

Consolidated from every slice's completion report + the freeze log + the launch-criteria checklist.
Engineering is complete for a controlled pilot; the items below are **owner / legal / credential**
actions only. Secrets go to the platform secret store (Vercel env / Supabase) — **never** the repo,
logs, or chat. Grouped by whether they block a **controlled no-payment pilot** vs full go-live.

## A. Blocking for a controlled pilot (do before onboarding a pilot org)

- [ ] **External penetration test** — booked (was due at S6, 4–8wk lead), executed against scope
      items 1–14, 15–22, 27, 30; **criticals fixed to 0** (mediums get dated fixes). *(doc 10 #51)*
- [ ] **DPA / PDPL posture** — for any **KSA** pilot holding visa/ID documents: document the lawful-
      transfer basis in the DPA, record the hosting region, complete a PII inventory. *(doc 10 #43,
      F-46)* A UAE-only pilot without KSA PII does not need this before start but does before KSA.
- [ ] **Arabic native reviewer** — sign off the all-surfaces Arabic review (zero open sev-1 language
      issues). The S10 AI sweep fixed the found sev-1s; a native human confirms. *(F-50)*
- [ ] **First restore drill** — run `runbooks/restore-drill.md` (DB **and** storage → plain PG17 +
      plain S3), file evidence with **measured RPO ≤ 1h / RTO ≤ 4h**. *(doc 10 #47/#48)*
- [ ] **Incident tabletop** — run `runbooks/incident-response.md`'s tabletop, file evidence. *(#50)*
- [ ] **Inngest Cloud keys** — provision so the nightly automation (exception sweep, cost-rollup
      invalidation, subscription lifecycle/dunning, retention prune) runs live. Until then the engine
      runs **on demand** and events queue durably to the outbox. *(runbooks/inngest-provisioning.md)*
- [ ] **Confirm Supabase PITR add-on** active on the hosted project + a nightly logical backup to a
      second provider/region (feeds the restore drill + backup monitor). *(doc 10 #46)*

## B. Blocking for taking real money / full go-live (not for a no-payment pilot)

- [ ] **D1 — incorporation & merchant of record.** Choose the entity country + payment merchant
      (leaning UAE + Stripe, **unverified** — confirm Stripe's KSA support at decision time). Gates
      the real payment adapter, live webhooks, per-currency price IDs, and the tax mechanism.
- [ ] **D3 — pricing numbers + tier limits.** Every seeded `plan_price` is `is_placeholder=true`;
      the limit values (full_users, active_jobs, storage_gb, ai_credits_month) are placeholders.
- [ ] **Tax mechanism** — provider-determined + D1-blocked (Stripe Tax vs merchant-of-record vs local
      gateway).
- [ ] **e-invoice / ZATCA certified partner** + credentials — the adapter is disabled in prod until
      then; no real government submission without it. *(D4/FR-16)*
- [ ] **Payment-provider credentials** — no real collection without them.
- [ ] **PB-3 accountant VAT sign-off** — ratify which VAT base a real org uses (both are built +
      golden-tested). *(OP-5)*
- [ ] **Org commercial config** — per-org pricing / tax / VAT-registration flag / thresholds.

## C. Credential-gated capabilities (enable when ready; each has a working disabled seam)

- [ ] **Sentry DSN** — error + worker-failure capture (env-gated; `runbooks/sentry-provisioning.md`).
- [ ] **Upstash** — durable per-user/per-org rate limits (in-memory fallback works meanwhile).
- [ ] **PDF render runtime** — headless-Chromium for the LPO/invoice PDFs (queued seam).
- [ ] **OAuth providers** — configure Google/Microsoft in Supabase + set `OAUTH_ENABLED=true` to show
      the buttons (email+password/OTP/TOTP work today).
- [ ] **Document malware scanner** — set `SCAN_PROVIDER` when document uploads are enabled (images are
      re-encoded + EXIF-stripped today; the doc-upload path is disabled-in-prod until a scanner exists).
- [ ] **Second-provider backup + management-API token** — makes the backup monitor a live check
      (`runbooks/backup-monitoring.md`).
- [ ] **AI-provider credentials + no-training contract terms** — narration/onboarding enrichment is
      optional; the deterministic path IS the shipped product.
- [ ] **Messaging (email/WhatsApp) credentials** — redacted notifications ride a disabled seam today.

## D. Housekeeping

- [ ] **OP-4 name check** — trademark / domain / Arabic-connotation check for "IdaraWorks".
- [ ] **Password rotation** — rotate the DB / app passwords before pilots (they were weak/personal).
- [ ] **Delete 4 junk Vercel projects** (idaraworks-bfs/bfsc/cd61/wfft) left from early attempts.
- [ ] **Pilot cohort** — line up 1–2 arm's-length GCC industrial SMBs (paying from month 2 at go-live;
      Najolatech is the test bench, not PMF proof).

## Notes

- The product operates fully for a **founder-onboarded, no-real-payment controlled pilot** with only
  Section A complete: the operational→money loop, redaction walls, commercial read-only states, support
  impersonation, and exports are all live; billing runs in its safe disabled-provider mode.
- Nothing in Sections B–D is an engineering task — the governed logic is built and tested behind seams;
  these are credentials, legal decisions, and pricing the owner supplies.
