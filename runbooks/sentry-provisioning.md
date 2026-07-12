# Sentry Provisioning (owner action — OA-4)

**Current state:** the Sentry integration is fully wired but ENV-GATED — with
no `SENTRY_DSN` every capture call is a clean no-op and the client bundle
loads nothing. The S0 §15 AC "Sentry receives a seeded error with request_id"
completes with the verification step below.

## 1. Provision (Sentry dashboard)

1. Create a Sentry organization → project, platform **Next.js**, name
   `idaraworks`.
2. Copy the **DSN** (Settings → Client Keys). The DSN is what the SDK posts
   events to; treat it as configuration (rotate via `secret-rotation.md`).

## 2. Install (Vercel production env)

```
vercel env add SENTRY_DSN production                 # server + edge capture
vercel env add NEXT_PUBLIC_SENTRY_DSN production     # browser capture (optional but recommended)
vercel env add NEXT_PUBLIC_APP_ENV production        # value: prod — client-side environment tag
```

Add the same to `.env.local` for local verification. Redeploy
(`vercel deploy --prod --yes`) — `NEXT_PUBLIC_*` is inlined at build time and
the CSP `connect-src` automatically extends to the DSN's ingest origin
(next.config.ts).

## 3. Verify — the seeded error (S0 §15 AC)

Local (with `SENTRY_DSN` in `.env.local`):

```
pnpm tsx tooling/scripts/seed-sentry-error.ts
```

The script captures one deliberate exception through the app's own wrapper and
prints the `request_id`. In Sentry, confirm:

- the event arrived with tags `request_id` (matching the printed value),
  `path`, `method`;
- **no PII**: no cookies, no request body, no headers beyond `x-request-id`,
  user context at most an id (the `scrubEvent` law — unit-tested).

Production path check: after deploy, any real 5xx also creates an issue via
`onRequestError` (instrumentation.ts) tagged with the middleware request id.

## 4. What arrives where (once live)

| Channel | Trigger | Tags |
| --- | --- | --- |
| `unhandled request error` | any server render/action/route failure | `request_id`, `digest`, `path`, `method` |
| React boundary capture | client-side render errors | `digest`, `boundary` |
| Worker failure | any `defineOrgFunction` handler throw | `worker`, `org_id`, `request_id` |
| `outbox_dead_letter` | relay sees exhausted events (page-worthy, Bible §15.4) | `channel`, ids/names context |

## Alert wiring (owner, in Sentry UI)

Minimum: an alert rule on `outbox_dead_letter` events and on first-seen issues
in `environment:prod` → email/phone of the operator. These are the Bible §15.4
page-worthy signals; tune the rest as tickets.

## Later (CI sourcemaps — optional)

`SENTRY_AUTH_TOKEN` in GitHub Actions + the build plugin would upload
sourcemaps for readable stacks. Deliberately NOT part of S0 (keeps the build
pipeline untouched); revisit when stack readability matters.
