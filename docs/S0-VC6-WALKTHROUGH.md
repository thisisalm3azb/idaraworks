# VC-6 — End-of-S0 Walkthrough (recorded validation session)

**Date:** 2026-07-12 · **Commit:** `5b6bc96` (`main`) · **Operator:** owner + AI pair
**Gate definition (S0 checklist §16):** *"End-of-S0 walkthrough: every §15 AC demonstrated in one session, recorded."*

All evidence below was produced in one validation session on 2026-07-12 against
commit `5b6bc96`: the full local gate run, the hosted integration run, the CI
run, the seeded lint-violation probes, and the production deployment + smoke +
browser walkthrough. Automated ACs cite the demonstrating suite (all green in
this session); manual 👁 items cite the recorded production walkthrough.

## Session gate results

| Gate | Result |
| --- | --- |
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck` | clean / 0 errors / clean |
| Unit (`pnpm test`) | **96/96** (13 files) |
| Hosted integration (`pnpm test:integration`) | **100/100** (11 files) — includes bleed + matrix + migration + wrong-ctx harnesses |
| Production build (`pnpm build`) | compiled; 13 routes (ƒ) + middleware |
| E2E (`pnpm test:e2e`) | **18/18** |
| GitHub CI on `5b6bc96` | quality ✅ 89s · integration ✅ 114s · **wall 118s** |
| Production smoke (`pnpm smoke:prod`, EXPECTED_COMMIT=5b6bc96) | see §15 rows below |

## §15 acceptance criteria — demonstration map

| # | Deliverable | AC demonstrated by (this session) |
| --- | --- | --- |
| 1 | **Repo + CI** | CI green end-to-end on `5b6bc96` (jobs above); **wall 118s ≤ 12 min (VC-5)**. Seeded-violation probes each failed lint as required: raw client (`import postgres` → `no-restricted-imports`), banned noun (`title="Open the boat job"` → `idaraworks/no-hardcoded-domain-nouns`), boundary (platform importing app → `boundaries/element-types`), inline audit write (`insert into public.audit_log` → `idaraworks/no-inline-audit-writes`); probes removed after the run |
| 2 | **RLS mechanism** | `tenancy-harness.test.ts` (wrong-ctx DB-block THROUGH the pooler; 0016 grant assertions) + migration harness in `setup.global.ts` + `vc1-mechanism.test.ts` — hosted run green |
| 3 | **Bleed harness** | `bleed-harness.test.ts`: org-purity + per-table liveness across all 19 org-scoped tables in 2 seeded orgs; registry-completeness check fails unregistered tables (both suites green hosted) |
| 4 | **Auth** | `identity.test.ts`: signup→org-create→owner membership, email + phone-provisioned invites, OTP rate limit, MFA enrol/enforce/audited reset, deactivated-membership rejection at ctx resolution, sign-in log rows |
| 5 | **Org settings** | `identity.test.ts` + `comms-config.test.ts`: country → working week/holiday calendar/base currency defaults (UAE/KSA/6-day); phone_login gate |
| 6 | **Entitlements** | `entitlements.test.ts` + `entitlements-catalogue.test.ts`: plan + override precedence, cache invalidation on override write, unknown key throws |
| 7 | **Audit/activity** | `audit.test.ts`: every S0 mutation writes audit (+activity) rows via `command()`; UPDATE/DELETE on audit tables fails as app_user |
| 8 | **Storage** | `files.test.ts` + `storage-harness.test.ts`: upload→re-encode→EXIF-GPS gone→thumb+medium; quota warn 80%/block 100% (reads served); class-map denial. VC-4 EXIF-in-deployment: Linux CI Sharp + hosted verification (Phase E accepted residual: in-Lambda probe blocked by deployment protection, by owner decision) |
| 9 | **Events** | `events-outbox.test.ts`: outbox→relay→idempotent consumer (duplicate publish), dead-letter alert on forced failure, worker wrong-org re-verification |
| 10 | **i18n/terminology/RTL** | Unit: `terminology.test.ts` (`term('job')` en/ar), `format.test.ts` (AED 2-dp, KWD 3-dp, `latn` digits under ar), `rtl-primitives.test.ts` + snapshots. 👁 e2e `smoke.spec.ts` ar-locale test + **production browser walkthrough** (2026-07-12, deployed app): full RTL shell (`lang=ar dir=rtl`), Arabic nav/members/account pages, no horizontal scroll — recorded in the deployment verification |
| 11 | **Observability** | `/api/health` checks **db/storage/queue** per-dependency (+ explicit inngest status) — `observability.test.ts` hosted + production smoke; logs org/user/request-tagged with no tenant values (logger law + `scrubEvent`/`safeProbeError` unit tests). **Sentry seeded error: integration wired + verification script ready (`seed-sentry-error.ts`); completes with the owner's DSN provisioning (OA-4) — documented residual, runbooks/sentry-provisioning.md** |
| 12 | **Docs** | `.env.example` (owner + rotation notes per var), `src/platform/events/README.md`, `runbooks/` (deployment/rollback, incident, dead-letter, rotation, restore-drill stub, Inngest + Sentry provisioning) — all committed |

## Production validation (this session)

- Deployed `5b6bc96` to `https://idaraworks.vercel.app` (icn1, Seoul-co-located).
- `pnpm smoke:prod` with `EXPECTED_COMMIT=5b6bc96`: **18/18 checks passed** —
  auth gates, security headers (CSP/HSTS/nosniff), x-request-id echo,
  readiness, health per-dependency truth (db 58ms / storage 400ms / queue 7ms;
  0 backlog, 0 dead-letters), **deployed-commit assertion
  (`commit=5b6bc96d…` == HEAD)**, and `/api/inngest` explicit
  `503 inngest_unconfigured` (owner action pending — never a generic 500).
- Live RTL on this exact deployment: `GET /login` with `Cookie: locale=ar`
  returns `<html lang="ar" dir="rtl">` with the Arabic catalog
  (تسجيل الدخول / البريد الإلكتروني) — §10's 👁 item re-confirmed on `5b6bc96`,
  complementing the authenticated full-shell walkthrough recorded earlier the
  same day.

## Documented residuals at S0 exit (all owner actions, none code defects)

1. **Inngest Cloud keys** (OA-4): workers not operational in production until
   `runbooks/inngest-provisioning.md` steps 1–4 pass (signed invocation).
2. **Sentry DSN** (OA-4): error-channel live-delivery evidence pends
   `runbooks/sentry-provisioning.md` step 3 (seeded error).
3. **Upstash Redis** (OA-4): rate limits run on the in-memory fallback until
   provisioned (required before pilots).
4. **VC-2** (Twilio OTP to a real UAE/KSA number): dispositioned in Phase C
   per OP-6 fallback (admin-issued credentials path).
5. Phase E accepted residual (owner decision): in-Lambda VC-4 probe.
