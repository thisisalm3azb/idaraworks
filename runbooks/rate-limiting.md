# Rate limiting

How request budgets work in IdaraWorks, which endpoints they protect, how the
client address is trusted behind Vercel, what happens when the shared store is
unavailable, how a person recovers from a limit, and how effectiveness is
verified across instances. Written for the security review of 2026-09-20.

## The three stores

`src/platform/http/rateLimit.ts` chooses one store per process from the
environment (`selectRateLimitStore`):

| Store | When | Scope of the budget |
| --- | --- | --- |
| **db** (default when `APP_ENV` is `prod` or `preview`) | always available: it is the application's own Postgres, through `app.rate_limit_hit` (migration 0143) | **shared by every instance and worker** — the only store that makes a budget real on Vercel |
| **upstash** | `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` set | shared; optional, for a deployment that prefers Redis latency |
| **memory** | local development and unit tests, or `RATE_LIMIT_STORE=memory` | **one process only**. `next start` runs several workers and Vercel runs many instances, each with its own map. It is not protection for a deployed app and is never presented as such. |

`RATE_LIMIT_STORE=db` forces the shared store locally (used by the cross-worker
proof below). Production needs **no new variable and no new vendor**: the
default on a deployed environment is the database store.

## Endpoints, keys and limits

| Rule | Where | Key | Limit |
| --- | --- | --- | --- |
| `login` | login action, OAuth kickoff | client address (fallback: email) | 10 / 5 min |
| `signup` | signup and register actions | client address (fallback: email) | 5 / hour |
| `password_reset` | forgot-password action; **password update after recovery** (per user) | client address; `user:<id>` | 5 / hour |
| `otp_send` | resend confirmation | client address | 5 / 10 min |
| `confirm` | **`/auth/confirm` (token-hash) and `/auth/callback` (code exchange)** | client address | 30 / 10 min |
| `invite_send` | invite / re-issue invitation | `<orgId>:<client address>` | 20 / hour |
| `invite_accept` | accept invitation | client address (fallback: user id) | 10 / 10 min |
| `health` | `/api/health` | client address | 30 / min |
| `share` | public share, form and signing pages and their actions | client address | 30 / min |
| `share_pdf` | public share PDF | client address | 6 / min |
| `pdf` | **authenticated document, studio and revenue-report PDFs** | `user:<id>` | 20 / min |
| `export` | **CSV export route** | `user:<id>` | 10 / 10 min |
| `identity` | public manifest and icon | client address | 60 / min |
| `webhook` | billing webhook | client address | 120 / min |
| `csp_report` | CSP report sink | client address | 20 / min |

Windows are fixed (one counter per key per window). A refusal carries
`retryAfterSeconds`, the time until the window rolls over.

## Trusting the client address behind Vercel

`src/platform/http/clientIp.ts`. On Vercel (`VERCEL=1`) only the headers the
platform sets and overwrites are consulted: `x-vercel-forwarded-for`, then
`x-real-ip`. A client-supplied `true-client-ip` or `x-forwarded-for` is
ignored there. Off Vercel (local, another host) the order is
`x-vercel-forwarded-for` → `true-client-ip` → leftmost `x-forwarded-for` →
`x-real-ip` → the constant `unknown` (a constant still throttles). Keys that
are per user (`pdf`, `export`, the recovery update) do not depend on the
address at all.

## When the shared store is unavailable

Decided per rule (`onStoreFailure` in `RATE_RULES`), because the two kinds of
budget fail differently:

- **Public and authentication budgets refuse** (`login`, `signup`,
  `password_reset`, `otp_send`, `confirm`, `invite_*`, `share`, `share_pdf`,
  `webhook`, `identity`, `csp_report`): a store that is down or answers too
  slowly (5 s) refuses the request with `retry-after: 5`, logging
  `shared rate limit store unavailable — refusing until it answers`. Failing
  open here would let the very flood that slows the store switch the guard
  off; the cost is one retry a moment later. A database outage already makes
  the application unusable, so this refuses nothing that would otherwise work.
- **Per-member cost budgets fall back to the per-process memory store**
  (`pdf`, `export`, `health`), logging
  `shared rate limit store unavailable — falling back to the per-process store`.
  Availability matters more than a precise count there, and the memory store
  still bounds the calling process.

Either way the log line at error level is the signal to look at the database,
and a degraded store is never mistaken for protection. The limiter uses its
own small pool (`RATE_LIMIT_POOL_MAX`, default 10) and one statement per call,
so a burst of public requests does not queue behind tenant transactions: a
burst of 70 concurrent manifest requests through a multi-worker `next start`
against the remote TEST project counted 60 allowed / 10 refused with no
store timeouts (an earlier build with a two-connection pool and a two-second
timeout timed out on most of that burst — which is how this section was
written).

## How a person recovers from a limit

- Sign-in, sign-up, resend, forgot-password: the page shows the translated
  "too many attempts" message; the same action works again when the window
  rolls over (five minutes for sign-in, an hour for sign-up and reset).
- Confirmation link: lands on `/auth/verify?reason=temporary` with the same
  link still valid; opening it again after the window succeeds.
- Password update after recovery: `?error=rate_limited` on the reset screen,
  with copy that says to wait and use the same link.
- PDF download and CSV export: a small page (or JSON for a script) with a
  `retry-after` header and the number of seconds to wait; the printable HTML
  document remains available immediately.
- Public share, form and signing pages: the "not available" page; it recovers
  on its own after a minute.

## Verifying effectiveness across instances

The memory store can never prove anything through a running server, because
each worker counts alone. The proof therefore has two parts:

1. **Unit** — `tests/unit/security-pass-two.test.ts` covers store selection,
   the shared-store answer mapping and the fail-open path.
2. **Cross-process** — start the app with `RATE_LIMIT_STORE=db` against the
   TEST project and issue more requests than the `identity` budget to the
   public manifest from one address: the 61st request must answer **429**
   with `retry-after`, even though `next start` spreads the requests over
   several workers. The same check against a deployment (production or a
   preview with a database) is the acceptance test after a deploy:

   ```bash
   for i in $(seq 1 63); do curl -s -o /dev/null -w "%{http_code}\n" https://<host>/api/o/<orgId>/manifest; done | sort | uniq -c
   ```

   Expect `60 200` and `3 429`. Before this change the same loop returned
   `63 200` on production, because the memory store was per instance.

## Counter table housekeeping

`app.rate_limit_bucket` is unlogged (a crash empties it, which only resets
budgets) and prunes itself: roughly one call in two hundred deletes buckets
whose window ended more than a day ago. The app role cannot read or write the
table directly; only `app.rate_limit_hit` touches it.
