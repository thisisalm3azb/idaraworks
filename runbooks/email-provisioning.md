# Email provisioning — branded, authenticated sending

**Status (2026-09-20):** the app is code-ready. Nothing is configured in
production: no sending domain is verified, no provider key is set, and the
hosted Supabase Auth project still sends its own default emails from
`noreply@mail.app.supabase.io` with its default templates. Everything below
needs the owner's accounts and DNS. Until it is done, IdaraWorks does not
deliver invitation emails (it shows the inviter a link to pass on instead) and
registration emails keep arriving from Supabase.

Two separate senders have to be configured. They can share one domain and one
provider account.

| Email                                                | Sent by                     | Configured where                                 |
| ---------------------------------------------------- | --------------------------- | ------------------------------------------------ |
| Confirm signup, reset password, magic link, change email | **Supabase Auth**          | Supabase dashboard → Auth (SMTP + templates)      |
| Invitations, document reminders, signature requests  | **the app** (`sendEmail`)   | Vercel env: `RESEND_API_KEY`, `EMAIL_FROM`        |

## 1. Verify a sending domain (DNS — owner)

Use a subdomain so the root domain's mail is untouched: `mail.idaraworks.com`.

1. Create a Resend account (or reuse one). Resend → Domains → Add domain →
   `mail.idaraworks.com`, region EU or US (either is fine).
2. Resend shows the records to add at the DNS host (GoDaddy for idaraworks.com).
   Add exactly what it shows; the values are per-account, so they are not
   reproduced here. Expect:
   - one **TXT** record for SPF on `send.mail` (or the name Resend shows),
   - one **MX** record on the same name (Resend's bounce handling),
   - one **TXT** record for DKIM (`resend._domainkey.mail`).
3. Add a **DMARC** record so receivers can trust the alignment:
   `_dmarc.mail.idaraworks.com  TXT  "v=DMARC1; p=quarantine; rua=mailto:postmaster@idaraworks.com"`
4. Wait for Resend to show the domain as **Verified** (minutes to a few hours).

Do not change the visible `From` address before the domain is verified:
receivers will junk or reject unauthenticated mail, and that is worse than the
Supabase default.

## 2. Supabase Auth: custom SMTP and branded templates (dashboard — owner)

Supabase → Project `anhgeeutrwftsvuzfinf` → Authentication → **SMTP Settings**:

| Field         | Value                                                   |
| ------------- | ------------------------------------------------------- |
| Enable custom SMTP | on                                                 |
| Sender email  | `no-reply@mail.idaraworks.com`                          |
| Sender name   | `IdaraWorks`                                            |
| Host          | `smtp.resend.com`                                       |
| Port          | `465`                                                   |
| Username      | `resend`                                                |
| Password      | a Resend API key created for this purpose (keep it only here) |

Then Authentication → **Email Templates**: paste the bodies from
`docs/EMAIL-TEMPLATES/` — one file per template — and set each **Subject**:

| Template          | File                                  | Subject                                  |
| ----------------- | ------------------------------------- | ---------------------------------------- |
| Confirm signup    | `confirm-signup.html`                 | Confirm your IdaraWorks email            |
| Magic link        | `magic-link.html`                     | Your IdaraWorks sign-in link             |
| Reset password    | `reset-password.html`                 | Reset your IdaraWorks password           |
| Change email      | `change-email.html`                   | Confirm your new IdaraWorks email        |
| Invite user       | `invite-user.html` (Supabase-side invites only; the app sends its own) | You're invited to IdaraWorks |

Every template links through the app's own verification route so that a link
works in any browser, not only the one that started the flow:

```
{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=signup      (confirm signup)
{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=recovery    (reset password)
{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=magiclink   (magic link)
{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email_change (change email)
```

`RedirectTo` is what the app passes as `emailRedirectTo`
(`https://www.idaraworks.com/auth/confirm?next=…`). Keep **Site URL** =
`https://www.idaraworks.com` and the redirect allow-list containing
`https://www.idaraworks.com/auth/confirm` and `https://www.idaraworks.com/auth/callback`.

Link lifetime is governed by Authentication → **Email OTP expiration**; the
templates state "expires in 1 hour", so keep that setting at 3600 seconds (or
change both together).

## 3. The app's own emails (Vercel — owner)

Vercel → Project `idaraworks` → Settings → Environment Variables → **Production**:

| Name             | Value                                             |
| ---------------- | ------------------------------------------------- |
| `RESEND_API_KEY` | a Resend API key (sending only)                   |
| `EMAIL_FROM`     | `IdaraWorks <no-reply@mail.idaraworks.com>`       |

Redeploy after adding them (environment changes need a new deployment). With
the key present, `sendEmail` posts to Resend's REST API with a 10-second bound;
invitations then say "Invitation emailed to …" instead of showing a link.

Keys never go in the repository, in logs, or in chat. The app logs only the
recipient and subject at debug level in the dev sink and nothing at all about
the key.

## 4. Controlled delivery test (owner approves the address)

1. Send yourself an invitation from a TEST-only company to an address you
   control and have approved for the test.
2. Confirm in Resend → Logs that the message shows **Delivered**, and that the
   envelope From is `no-reply@mail.idaraworks.com` with DKIM = pass.
3. Open the message in Gmail: "Show original" → SPF pass, DKIM pass, DMARC pass.
4. Register a fresh account with a second approved address and check the
   confirmation email arrives from IdaraWorks, with the branded template, and
   that its link lands on `/auth/confirm` and signs you in.

An API "accepted" response is not delivery. Only a Delivered event and the
message in the inbox count.

## 5. What can go wrong

- **Emails still from Supabase** → custom SMTP not enabled, or the sender email
  is not on the verified domain.
- **"Invalid or expired link"** → the template still uses `{{ .ConfirmationURL }}`
  (browser-bound) instead of the token-hash form above, or Site URL is wrong.
- **Invitations show a link instead of "emailed"** → `RESEND_API_KEY` missing in
  Production, or the deployment predates the variable.
- **Delivered but in spam** → DMARC missing or the From domain differs from the
  DKIM domain.
