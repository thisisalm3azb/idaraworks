# Secret Rotation (phase2/10 #37; checklist §12)

**Standing rules:** quarterly rotation for everything below; **immediate**
rotation for any key that ever touches a chat, log, screenshot, or ticket.
Secrets exist ONLY in the platform stores listed here — never in the repo
(gitleaks enforces in CI), never in chat.

| Secret | Store(s) | Rotate by | Notes |
| --- | --- | --- | --- |
| `APP_DB_PASSWORD` (app_user) | Vercel env; `.env.local` | Generate new →`alter role app_user password '…'` via `DIRECT_URL` → update stores → redeploy | App derives its pooled connection from this (env.ts); DATABASE_URL itself stays password-redacted |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env.local` (tooling), GitHub `migrations` env ONLY | Supabase dashboard → JWT keys → rotate | **Never** in Vercel/app runtime (phase2/10 #1, lint-guarded) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel env; `.env.local` | Supabase dashboard rotate → update stores → redeploy | Public by design; auth-only privileges (0002/0016 revokes) |
| `STORAGE_S3_ACCESS_KEY_ID` / `STORAGE_S3_SECRET_ACCESS_KEY` | Vercel env; `.env.local`; GitHub CI | Supabase dashboard → Storage → S3 access keys: create new pair → update stores → verify `/api/health` storage.ok → revoke old | Storage-scoped credential; cannot touch the DB (Bible §5.2) |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | Vercel env (once provisioned) | Inngest dashboard → keys → rotate (signing key supports dual-active rotation) → update Vercel → redeploy | See `inngest-provisioning.md` |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | Vercel env (once provisioned) | Sentry → project settings → client keys | DSN is low-sensitivity but treat as config; `SENTRY_AUTH_TOKEN` (CI sourcemaps, future) is CI-only |
| Vercel CLI login | Local machine | `vercel logout` / re-login | Deploy authority |
| GitHub push credentials | Local git credential store | GitHub settings → tokens | Repo authority |

## Procedure template (any key)

1. Create the NEW credential in the issuing dashboard (old still active).
2. Update every store listed above for that key (Vercel: `vercel env rm NAME
   production --yes` then `vercel env add NAME production` with the value piped
   — never typed into a shared terminal or chat).
3. Redeploy (`deployment-and-rollback.md`) and run `pnpm smoke:prod` — the
   health checks prove DB/storage credentials work.
4. Revoke the OLD credential.
5. Log the rotation (date, key name, reason) in the ops log — quarterly entries
   are checklist §12 evidence.

## Emergency (suspected leak)

Rotate immediately in this order: service-role key → APP_DB_PASSWORD → storage
keys → anon key → Inngest/Sentry. Then audit `sign_in_log` and Supabase auth
logs for the exposure window, and follow `incident-response.md` scoping.
