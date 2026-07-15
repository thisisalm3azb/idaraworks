# AUTH_CALLBACK_FIX — email-confirmation redirect failure (U1)

## The defect (real prod)

A new user signed up on **https://idaraworks.vercel.app**, received the confirmation
email, clicked the link — and landed on `http://localhost:3000/?code=…` →
**"refused to connect"**. Confusingly, the email *was* verified (Supabase marks the
address confirmed when the link is clicked, before the redirect), so the user could
sign in — but the flow looked completely broken.

## Root causes

1. **`signupAction` passed no `emailRedirectTo`** (`src/app/(auth)/actions.ts`).
   Supabase then falls back to the project **Site URL** in Auth → URL Configuration,
   which was still the default `http://localhost:3000`.
2. **`/auth/callback` was OAuth-only** (`src/app/auth/callback/route.ts`): every
   failure was branded `oauth_failed`, and it never carried a post-auth destination.
3. **Nothing handled `?code=` at the root path** — which is exactly where the
   Site-URL fallback sends users (`{siteUrl}/?code=…`).

## The code fix (all three layers)

1. **`signupAction` now sends
   `emailRedirectTo = {requestOrigin}/auth/callback?next=/onboarding`**
   (`src/app/(auth)/actions.ts`). The origin is derived from the live request
   (`requestOrigin` in `src/platform/auth/callback.ts`: `x-forwarded-host` →
   `host` → `APP_URL` → `http://localhost:3000`), so **each deployment's signups
   return to that same deployment** — prod to prod, previews to the preview URL,
   local to localhost. The OAuth action uses the same helper.
2. **`/auth/callback` serves both OAuth and email confirmation**
   (`src/app/auth/callback/route.ts`): it exchanges the code, then redirects to a
   **sanitized** `next` (`sanitizeNext`: must start with `/`, must not start with
   `//`, must not contain `\`, `://`, or control characters — otherwise `/`).
   Failure modes are distinguished:
   - no `code` → `/login?error=confirm_missing`
   - code already used / expired (double-click, mail-scanner prefetch — the email
     is typically already verified) → `/login?notice=already_confirmed`
     ("already verified — sign in", friendly, not an error)
   - genuinely invalid → `/login?error=confirm_invalid`
   The login page whitelists these params (`NOTICE_KEYS` / `ERROR_KEYS` in
   `src/app/(auth)/login/page.tsx`); copy lives in `auth.login.*` keys in
   `en.json` + `ar.json`.
3. **Root resilience** (`src/middleware.ts`): any request to `/` carrying
   `?code=` is forwarded to `/auth/callback` with all params preserved and a
   default `next=/onboarding`. So even if only the Supabase **Site URL** is
   corrected (and the allowlist / `emailRedirectTo` never take effect for old
   emails), the code still gets exchanged and the user still lands signed in.

After a successful exchange the browser holds a session; `/onboarding` renders the
create-workspace form for no-org users (it redirects to `/login` only when there is
no session), and `/` resolves via `resolveLanding` to the first org or onboarding.

## Owner action required — Supabase dashboard (one-time)

**Supabase Dashboard → Authentication → URL Configuration:**

| Setting | Value |
| --- | --- |
| **Site URL** | `https://idaraworks.vercel.app` |
| **Redirect URLs** (allowlist) | `https://idaraworks.vercel.app/**` |
| | `http://localhost:3000/**` (local dev) |
| | *(optional)* `https://idaraworks-*.vercel.app/**` (Vercel preview deployments) |

Why both settings matter:

- **Redirect URLs** is an allowlist: `emailRedirectTo` is honoured **only if it
  matches an entry**. Without the prod entry, Supabase silently falls back to the
  Site URL — which is how this defect happened.
- **Site URL** is the fallback target for anything not covered by
  `emailRedirectTo` (old emails already in inboxes, template links, recovery
  flows). It must be the production origin, never localhost.

## Behaviour per environment (after this fix)

| Environment | Confirmation link returns to | Notes |
| --- | --- | --- |
| Production | `https://idaraworks.vercel.app/auth/callback?next=/onboarding` | Needs the prod Redirect-URL entry. |
| Vercel preview | the preview deployment's own origin | Needs the preview wildcard entry; otherwise falls back to Site URL (prod) — still functional via the root forwarder, just lands on prod. |
| Local dev | `http://localhost:3000/auth/callback?next=/onboarding` | Needs the localhost entry. Local/CI usually run with confirmations off (session returned at signup → straight to `/onboarding`). |

## Why the code is now resilient to a Site-URL-only correction

If the owner fixes **only** the Site URL and never touches the allowlist,
`emailRedirectTo` is not honoured and links land on
`https://idaraworks.vercel.app/?code=…`. The middleware forwarder catches that,
sends the code to `/auth/callback?next=/onboarding`, the exchange succeeds, and the
user lands on onboarding with a session — the flow works end-to-end anyway. The
allowlist entries are still recommended so previews and localhost return to their
own origins.

## Tests

`tests/unit/auth-callback.test.ts` — origin derivation, next-sanitizer
(open-redirect vectors: `//evil.com`, `https://evil.com`, `/\evil.com`, encoded
absolute URLs, control characters), exchange-error classification, the callback
route's four outcomes (mocked `supabaseServer`), and the middleware root-forward.
