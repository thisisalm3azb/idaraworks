# Pilot Launch — Progress Tracker

Anchor doc for the **controlled-pilot preparation phase** (post-MVP; NOT S12, NOT feature
development). Records the verified baseline, the launch-prep package, and the exact next step. The
pilot org is NOT created and NO invitation is sent until the owner supplies + approves the intake
(`PILOT_ORG_INTAKE_FORM.md`). Alpha Marine + TESTING are never modified.

## Verified baseline (2026-07-14)

| Check | Result |
| --- | --- |
| HEAD = origin/main = production commit | ✅ `97985e1` (all three identical) |
| CI + full S0–S11 regression | ✅ green on `97985e1` (unit/integration/e2e/perf) |
| Production smoke | ✅ 18/18 (incl. deployed-commit assertion) |
| Hosted migrations | ✅ `0000–0064`; next `0065` |
| Production orgs | ✅ exactly [Alpha Marine `d22b2098…`, TESTING `9fcaa697…`] |
| Synthetic test/demo/pilot residue | ✅ zero (S7/S8/S9 tables 0; PERF leftover removed) |
| Working tree | ✅ clean, synchronized with `origin/main` |
| S10 / S11 / MVP reports | ✅ complete (`docs/S10-…`, `docs/S11-…`, `docs/MVP-READINESS-REPORT.md`) |

## Launch-prep package (this phase)

| Doc | Purpose | Status |
| --- | --- | --- |
| `PILOT_LAUNCH_PROGRESS.md` | this tracker | ✅ |
| `PILOT_LAUNCH_PLAN.md` | §0 capability classification + 15-phase 2–4wk operating plan | ✅ |
| `PILOT_OWNER_ACTIONS.md` | 4-tier prioritized owner-action checklist (supersedes docs/pilot/08) | ✅ |
| `PILOT_CREDENTIAL_MATRIX.md` | exact env-var credential matrix (10 providers) | ✅ |
| `PILOT_MONITORING_CHECKLIST.md` | daily + weekly operator monitoring | ✅ |
| `PILOT_SUPPORT_CHECKLIST.md` | support intake + severity escalation matrix | ✅ |
| `PILOT_SUCCESS_SCORECARD.md` | measurable success criteria + stop conditions | ✅ |
| `PILOT_ORG_INTAKE_FORM.md` | the consolidated owner-input form (fill before any org is created) | ✅ |

All 8 verified: accuracy spot-check passed (no provider claimed active that prod config doesn't set;
no secret-like values anywhere). **Package COMPLETE — awaiting the owner's completed intake form +
Tier-A confirmation before any org/user/invitation is created.**

These CONSOLIDATE + reference the existing `docs/pilot/00–08` playbook, `docs/guides/*`, and
`runbooks/*` — they do not replace them. No conflicting duplicates.

## Production configuration truth (drives every classification)

PROD env vars SET: `APP_ENV=prod`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`DATABASE_URL` (pooler, password-redacted), `APP_DB_PASSWORD`, `STORAGE_S3_*`. Deliberately NOT
deployed: `SUPABASE_SERVICE_ROLE_KEY`, `DIRECT_URL`. **Everything else is unset** → Inngest, Sentry,
Upstash, Resend (email), OAuth, malware scan, AI narration, billing, and e-invoice are all
**disabled/degraded in production** (each with a safe fallback — see `PILOT_CREDENTIAL_MATRIX.md`).
`/api/health` shows `inngest: unconfigured` accordingly.

## Hard constraints (this phase)

- Do NOT create a real org / user / invitation / commercial config until the owner supplies +
  approves `PILOT_ORG_INTAKE_FORM.md`.
- Do NOT activate real payments or any D1-gated capability.
- Do NOT modify Alpha Marine or TESTING.
- Never request / print / store / commit secret VALUES — only name env vars + where to set them.
- No feature roadmap, no post-MVP engineering.

## Exact next step (resume instruction)

1. Owner fills `PILOT_ORG_INTAKE_FORM.md` and works the **Tier A** items in `PILOT_OWNER_ACTIONS.md`
   (the genuine pre-login blockers).
2. Owner replies with the completed intake + confirmation that Tier A is done (or which items remain).
3. Only THEN: configure the first real pilot org exactly to the intake (create org → template →
   terminology → masters → first admin invite), verify per `PILOT_LAUNCH_PLAN.md` Phase 1–3, and
   begin the pilot. Nothing is created before that approval.

The consolidated owner-input request + the recommended pilot profile are in `PILOT_ORG_INTAKE_FORM.md`
and the final summary of this phase.
