# Inngest Cloud Provisioning (owner action — OA-4)

**Current production state (documented residual):** `INNGEST_SIGNING_KEY` /
`INNGEST_EVENT_KEY` are not provisioned. `/api/inngest` returns an explicit
`503 {status: "inngest_unconfigured"}` and `/api/health` reports
`checks.inngest.status = "unconfigured"`. Domain events written by the app
accumulate in the outbox (safe, at-least-once by design) and are **not**
relayed; production workers are **not operational** until the steps below are
completed and verified. Local dev / CI are unaffected (Inngest dev mode).

**Never** set `INNGEST_DEV=1` in production — it would accept unsigned
invocations (forbidden; signature verification is the trust boundary).

## 1. Provision (Inngest dashboard)

1. Create an Inngest account/organization → create app **`idaraworks`**
   (the client id in `src/platform/events/inngest.ts` — must match).
2. Use a **production** environment for production keys; per-environment keys
   for preview if preview relaying is ever wanted (checklist §12: test vs live
   keys are separate).
3. Copy two values (do not paste into chat/tickets):
   - **Event key** (`INNGEST_EVENT_KEY`) — Events → Manage event keys.
   - **Signing key** (`INNGEST_SIGNING_KEY`) — Settings → Signing key.

## 2. Install (Vercel production env)

From the repo root (values piped, never echoed):

```
vercel env add INNGEST_EVENT_KEY production      # paste value at the prompt
vercel env add INNGEST_SIGNING_KEY production    # paste value at the prompt
```

Also add both to `.env.local` ONLY if local runs should use the cloud
environment (normally not — local dev uses the Inngest dev server).

Redeploy: `vercel deploy --prod --yes` (env changes need a new deployment).

## 3. Register the app with Inngest Cloud

1. Inngest dashboard → Apps → **Sync app** → URL:
   `https://idaraworks.vercel.app/api/inngest`.
2. The sync must show the registered functions:
   `outbox-relay` (+ its dead-letter/retention schedules), `demo-heartbeat`,
   `image-derivatives`.

## 4. Verify (in order — all four must pass)

1. **Route:** `GET https://idaraworks.vercel.app/api/inngest` no longer returns
   `inngest_unconfigured`; `/api/health` shows
   `checks.inngest.status = "configured"`.
2. **Signed invocation:** in the Inngest dashboard, invoke `demo-heartbeat`
   (Functions → Invoke) with a real org/actor pair:
   `{"data": {"orgId": "<org uuid>", "actorUserId": "<member uuid>"}}`.
   The run must succeed — this proves signature verification + the
   org re-verification harness end-to-end. A forged pair must FAIL
   (OrgVerificationError) — that failure is the security control working.
3. **Relay:** confirm the `outbox-relay` schedule runs green and
   `/api/health` → `checks.queue.unprocessed` drains to 0 (any events
   accumulated pre-provisioning are delivered; consumers are idempotent).
4. **Rejection:** `curl -X POST https://idaraworks.vercel.app/api/inngest`
   (unsigned) must be REJECTED (401/400) — never executed.

Only after all four: production workers may be declared operational.

## Rotation

Signing key: Inngest supports dual-active rotation (Settings → rotate) —
add the new key to Vercel, redeploy, then retire the old in the dashboard.
Event key: create new → update Vercel → redeploy → revoke old.
Log rotations per `secret-rotation.md`.
