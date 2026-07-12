# Deployment & Rollback (Vercel production)

**Scope:** deploying `main` to the production project `idaraworks`
(team `najolatech-s-projects`, alias `https://idaraworks.vercel.app`) and
rolling back. Migrations are forward-only and expand-first (Bible §14.5/§14.7),
so **app rollback is always safe** and never requires a data rollback.

## Preconditions

- `main` is green in GitHub CI (both `quality` and `integration` jobs).
- Working tree clean at the commit being deployed (`git status`).
- `.env.local` present (migration runner credentials; never committed).
- Do not change: `vercel.json` (`framework`, `regions: ["icn1"]`, hoisted
  install command) or `next.config.ts` `outputFileTracingIncludes` — these are
  the sharp/libvips packaging fix and the DB co-location (Seoul) pin.

## Deploy

1. **Migrations first** (expand → migrate → contract; Bible §14.5):
   `pnpm db:migrate` — applies any new `supabase/migrations/*.sql` to hosted
   via `DIRECT_URL`. Forward-only; the runner records applied filenames.
2. **Local gate:** `pnpm build` must compile clean.
3. **Deploy:** `vercel deploy --prod --yes` from the repo root (repo is linked
   via `.vercel/repo.json`). The build runs on Vercel (Linux) — never deploy
   `--prebuilt` from Windows (platform-specific sharp binaries).
4. **Verify:** `EXPECTED_COMMIT=$(git rev-parse HEAD) pnpm smoke:prod` — all
   checks must pass, including the deployed-commit assertion (health exposes
   `VERCEL_GIT_COMMIT_SHA`). Then spot-check `/api/health` shows
   `db.ok`, `storage.ok`, `queue.ok` true.
5. **Record the rollback path** in the release notes: the previous Ready
   production deployment URL from `vercel ls idaraworks`.

## Rollback

App rollback = point the alias back at the last good deployment (Bible §14.7):

1. `vercel ls idaraworks` — find the previous **Ready / Production** deployment.
2. `vercel promote <previous-deployment-url>` (or
   `vercel alias set <previous-deployment-url> idaraworks.vercel.app`).
3. `pnpm smoke:prod` against the alias; confirm `commit` in `/api/health` is
   the intended prior sha.
4. Migrations are **not** rolled back (forward-only). If the bad release
   included a migration, the previous app version must tolerate it — that is
   what expand-first guarantees; verify the specific migration's rollback note
   (each migration file header carries one).
5. Open an incident record if user-facing impact occurred
   (`incident-response.md`).

## Environment variables (names only — values live in Vercel encrypted env)

Production env is documented in `.env.example` with owner + rotation notes.
Runtime holds: `APP_ENV`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `DATABASE_URL` (password-redacted; runtime
derives `app_user` + `APP_DB_PASSWORD`), `APP_DB_PASSWORD`,
`STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY`, and once
provisioned `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `SENTRY_DSN`
(+ `NEXT_PUBLIC_SENTRY_DSN`). **Never** in runtime env:
`SUPABASE_SERVICE_ROLE_KEY`, `DIRECT_URL` (tooling/CI only — phase2/10 #1).
