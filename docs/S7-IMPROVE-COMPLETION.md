# S7 — Improve / Intelligence — Completion Report

**Status:** COMPLETE · deployed `63bff3d` (code `a5485ab`; prod `/api/health` + 18/18 smoke confirm) · CI green (run 29290957958) · Arabic DoD demo PASS · **production baseline restored**.
**Date:** 2026-07-14 · **Commits:** `af88959`, `051950b`, `27ab952`, `137d07c`, `833215c`, `c6efe9c`, `a5485ab` (review fixes + regressions), `63bff3d` (docs/tooling) + final checkpoint.

## What shipped — the morning-intelligence loop (doc 04 / doc 11 S7)

Each working morning a **per-org nightly run** composes a deterministic **digest** from authoritative
DB facts, raises/self-heals the new **exception rules**, and (optionally) narrates the digest with AI
that can only *rephrase* — never introduce a number. The owner opens one card; the customer, if invited,
sees a safe, tokenized, revocable snapshot. Nothing here can move a governed record.

- **Exception rules E-05/E-06/E-08/E-13** added to the nightly engine (raise + dedup + severity + auto-clear,
  calendar/tenant/role/audience/job-scoped, C-10 precedence honoured):
  - **E-05 margin drift** — full cost (incl. labour, read across the D-6.2 wall via a SECURITY DEFINER
    candidate helper that returns **percentages only**) vs C-10 quoted, and the pre-final cost-of-quote arm.
  - **E-06 late supplier** — overdue approved-unreceived POs, per-PO and (≥ threshold) per-supplier.
  - **E-08 unusual expense** — event-driven ≥3× median outlier with a minimum prior sample; self-clears on void.
  - **E-13 document expiry** — employee ID/passport/visa within the window, read across the owner/admin HR
    wall via a DEFINER helper that returns **(employee, doc-type, expiry) only** — never the document number.
- **Staggered nightly scheduler** — one cron fans out per-org `nightly/org_due` events on a deterministic
  FNV-1a per-org offset (de-herd), each handled by a concurrency-capped `defineOrgFunction`; the whole seam
  stays behind the **Inngest-disabled-in-production** flag until the owner provides keys.
- **Deterministic digest** — composed from DB facts, evidence-linked, money computed at compose time by the
  trusted run and **redacted again per reader** at read (F-23 backstop). Idempotent upsert per (org, audience,
  date). Works with **no AI** (the outage / no-credentials fallback).
- **AI narration seam** — optional wording, disabled by default; a **fake/disabled** provider seam (mirrors
  the e-invoice adapter); a closed prompt carrying **labels + non-financial counts only**; a **numbers-subset
  validator** that rejects any invented (or money-looking) figure → deterministic fallback; metered into the
  append-only `ai_interaction` ledger. Missing credentials are never a blocker.
- **Customer update drafts** — drafted from governed facts, separate from confirmed records; authorized
  review/publish; every action audited; **customer-safe redaction** (no internal cost / labour / margin /
  approvals / issues).
- **Tokenized customer share surface** — public `/s/[token]`, no auth; a high-entropy (sha256-hashed),
  non-enumerable, **revocable + expiring** token resolved by a safe DEFINER resolver; identical
  non-revealing response for invalid / expired / revoked / rate-limited; rate-limited per trusted client IP;
  no org/subject id, internal navigation, or auth data ever leaves.
- **Quote-versus-actual** — `getJobCosting` now reads the accepted quote as the C-10 quoted value (the
  `quote_divergence` alarm, dead since S5, is live again); cost/price walls hold; base-currency minor units.
- **Owner Today digest card** — a governed S7 card with freshness + evidence deep-links; AI optional and
  degrades safely; role redaction; Foreman / Manager / Accounts / Procurement Today screens preserved.
- **Platform wiring** — permissions in both matrix transcriptions; events registry + Inngest parity; worker
  fleet registration; entitlement (`feat.ai_narration`) + credit-limit enforcement; en/ar/RTL/375px;
  terminology via the `{job}` variable (no hardcoded domain nouns). No S8 functionality.

## Migrations (hosted Seoul DB now at 0000–0049)

- `0045` exception `rule_key` widened (margin_drift, late_po, late_supplier, unusual_expense, document_expiry) + subject index.
- `0046` `digest` table + append-only `ai_interaction` ledger (grant covers the upsert columns).
- `0047` `customer_update` + `share_token` + `app.resolve_share_token` DEFINER (draft-only UPDATE policy, no self-recursion).
- `0048` `app.margin_drift_candidates` + `app.document_expiry_candidates` DEFINER candidate helpers (walled reads → non-sensitive rows).
- `0049` **review-fix**: both DEFINER helpers hardened with the `p_org = app.current_org_id()` self-check (no cross-org read via a foreign uuid).

## Adversarial review — 6 confirmed findings, all fixed + regression-covered

Independent multi-lens review (redaction/privacy, tenancy, AI-safety, state-machine, rate-limit, i18n):

| # | Sev | Defect | Fix | Regression |
|---|-----|--------|-----|-----------|
| 1 | HIGH | AI narration built its allow-list from **all** payload numbers incl. money; the single narration row is returned to every `digest.view` audience → a money figure in prose bypassed the F-23 wall | `buildNarrationInputs` sends + allows **counts only**; money never enters the model or the allow-list | unit (buildNarrationInputs money-exclusion) |
| 2 | HIGH | numbers-subset regex `[\d,.٫٬]*` ate a trailing `.`; `canonicalize` returned null; the token was **silently dropped** — a hallucinated sentence-final number was never checked (fail-open) | tightened token (decimal needs following digits); uncanonicalizable → NaN → **offending** (fail-closed) | unit (sentence-final hallucination + decimal cases) |
| 3 | MED | share-page rate-limit key derived from spoofable `x-forwarded-for` → a loop could vary XFF per request and never trip the per-IP throttle on the no-auth surface | shared `clientIpFromHeaders` prefers the platform-trusted header; XFF only as fallback | unit (clientIpFromHeaders precedence) |
| 4 | MED | the two DEFINER candidate helpers trusted `p_org` → a caller passing a foreign uuid could read another tenant's walled candidates | migration `0049` adds `p_org = app.current_org_id()` self-check to both | S7 integ (cross-org helper returns 0 rows) |
| 5 | MED | digest `at_risk` / `customers_awaiting` headline counts used the **LIMIT-10 preview length** → understated the true total at >10 | dedicated `count(*)` (same WHERE, no LIMIT); items[] stay capped at 10 | S7 integ (count > 10, items ≤ 10) |
| 6 | LOW | owner Today card rendered hardcoded English `as of {time}` (the digest card already used the i18n key) | wire `today.card_as_of` into `TodayCardView` | i18n parity + Arabic prod demo |

## Gates

format ✓ · lint 0 errors ✓ · typecheck ✓ · **unit 273/273** (incl. 4 new review regressions) · build ✓ ·
**S7 hosted integration 10/10** (E-05/06/08/13 lifecycles + digest/narration/meter + customer-share flow +
quote-vs-actual + cross-org DEFINER + count-not-capped, verified vs the real Seoul DB) · **full integration
suite green on GitHub CI** (run 29290957958, local ephemeral Supabase on Linux — "Apply all migrations" incl.
0049 + full `test:integration`) · **e2e green on CI** · **deployed commit confirmed** (prod `/api/health`
`commit=a5485ab` + 18/18 `smoke:prod` checks incl. "deployed commit matches").

**Environment note:** the local hosted-integration run against Seoul was ~15–20× normal latency during this
session (10–21 s per test), so the full multi-file suite could not complete locally in a reasonable window; a
zero-S7 control file behaved identically, confirming it is environmental, not a code fault. The S7 file was
validated in isolation vs hosted (10/10) and the full suite is green on CI — the same split S6 used.

## Production DoD demo (Arabic, `tooling/scripts/s7-prod-demo.ts`)

Synthetic Arabic org **قوارب الذكاء** (Alpha Marine + TESTING never touched), against the production DB:

- nightly raised **margin_drift=1 (E-05), late_supplier=4 (E-06), document_expiry=1 (E-13)**; digest 8 sections.
- **thirteen-questions gate: 13/13** answered from the deterministic digest.
- AI narration `status=generated`, **1 validated + metered** `ai_interaction` row (numbers-subset gate held).
- **money wall HELD**: price-privileged reader sees the figure, non-privileged sees `null`.
- customer update **draft → send → public resolve (safe, no cost) → revoke → dead**.
- **quote-vs-actual**: accepted quote wins C-10; `quote_divergence` exception raised.
- **DoD: PASS**; self-cleanup left **0** org rows.

## Owner actions from S7 (documented, non-blocking — governed logic built, integration seam disabled)

- **AI narration provider + credentials** — the narration seam is disabled in production; the deterministic
  digest is the source of truth and works without it. Wiring a real provider is optional.
- **Inngest Cloud keys** — the staggered nightly fan-out is registered but the worker fleet stays disabled in
  production until keys are provided (the nightly can be invoked directly meanwhile).
- Carried from earlier slices: production PDF render runtime, e-invoice certified partner, payment-provider
  credentials, Sentry DSN, Upstash, password rotation, delete junk Vercel projects.

## Production baseline — RESTORED

Both protected orgs — **Alpha Marine** (`d22b2098…`) and **TESTING** (`9fcaa697…`) — were **never read for
deletion or written** by S7 build, tests, or demo. The Arabic DoD demo self-cleaned (0 leftovers).

With owner approval, the guarded cleanup (`tooling/scripts/s7-cleanup.ts --apply`) removed the **15 synthetic
test orgs** (8× `S7 Org`, 1× `S7 Org B`, 3× `S6 Org`, 2× `S4 Org`, 1× `S3 Org`) left by non-self-cleaning
integration `afterAll`s and killed full-suite runs — **15 orgs + 25 synthetic-only users + 2,175 tenant rows**,
including the 149 synthetic outbox events. The two protected orgs were excluded by **name AND UUID** with a hard
abort guard; only users with no protected-org membership were removed.

**Post-cleanup verification** (`tooling/scripts/s7-inventory.ts`):

- `ORGS: 2` — exactly **Alpha Marine** + **TESTING**.
- S7 tables `digest / ai_interaction / customer_update / share_token` = **0**; exceptions with S7 rule_keys = **0**.
- prod `/api/health`: `ok=true`, `commit=63bff3d`, db/storage/queue ok, queue `unprocessed=0`.

Pre/post baseline **matches** (two protected orgs, all S7 tables empty for them — they never used S7).
