# Which database each test command talks to

The integration suite **creates and deletes organizations, users and records**.
Where it points is a safety question, not a configuration detail.

## What went wrong

`vitest.integration.config.ts` loaded `.env.local` through `tooling/scripts/load-env.ts`.
That file holds the credentials for Supabase project `anhgeeutrwftsvuzfinf` — the
project that serves `www.idaraworks.com`. So every local integration run created
and deleted organizations **in the live database**, and every run that was
interrupted left its organizations behind there. That is where the leaked test
organizations came from.

The unit suite was never affected: it touches no database.

## The rule now

Integration tests read `.env.test.local`, then `.env.test`, then `.env`. They do
**not** read `.env.local`. Before anything connects or migrates,
`tests/integration/setup.global.ts` calls `assertNotProduction()`, which refuses
to continue if the Supabase project reference, either database URL, or the
application URL belongs to production. The refusal names every reason it found
and how to fix it.

Getting past it requires setting `I_KNOW_THIS_WRITES_TO_PRODUCTION` to the exact
value `yes-destroy-anhgeeutrwftsvuzfinf`. The phrase names the project it will
damage so it cannot be set absent-mindedly, and it is conspicuous in a shell
history or CI log. Truthy values like `1`, `true` or `yes` do not work.

## Commands

### Local development

```bash
supabase start
cp .env.test.example .env.test.local   # fill in the keys `supabase start` prints
npm run test:integration
```

`supabase start` runs a throwaway Postgres on `127.0.0.1:54322`. Nothing it
contains matters, which is the point.

To use a hosted throwaway project instead, put that project's credentials in
`.env.test.local`. Any project other than the production one passes the guard.

### Unit tests

```bash
npm test
```

No database, no environment file, safe anywhere.

### CI

CI already builds its own stack. `.github/workflows/ci.yml` runs `supabase start`
and exports `DIRECT_URL`, `DATABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` into the
job environment, all pointing at `127.0.0.1`. `dotenv` never overwrites a variable
that is already set, so the new loader changes nothing for CI — and the guard now
protects it too, at no cost.

### Staging

Point `.env.test.local` at the staging project. The guard only recognises
production, so a staging project reference passes, and a `staging.idaraworks.com`
application URL is explicitly not production.

### Production

**Never run the integration suite against production.** Production is verified by
narrow smoke journeys through the real interface:

```bash
npm run smoke:prod
```

A journey that must write follows one rule: create exactly one organization named
so its purpose is obvious, mark it with `app_settings['test.fixture']`, do the
smallest thing that proves the deployment works, then delete it immediately and
confirm zero residue. One organization, one journey, cleaned up in the same run.

## Finding leftovers

```bash
npm run test:residue
```

Reports what is in the database and why, and never deletes. Every organization is
accounted for in one of four groups — confirmed fixture, needs review, seeded
demo, not a candidate — and the command fails if the four groups do not add up to
the number scanned, so nothing can be quietly omitted.

Disposable data is never identified by name alone: `public.org.name` has no
uniqueness constraint, and nothing stops a real tenant from being called
"S9 Org". An organization is confirmed only when it carries the fixture marker it
wrote about itself, or when its name, its logins and its emptiness all agree.

## Why the marker exists

`public.org` has no metadata column, so each suite records what it is in
`app_settings['test.fixture']` at creation time via `markFixtureOrg`. A marker
written by the organization itself is far better evidence than anything inferred
afterwards, and it is what makes cleanup safe to automate later.

## Using the hosted test project (what we actually run)

`idaraworks-test` (`zwnnqaryouevnzuwtyaj`, Tokyo, Free Nano) is the isolated
project. Setup, in order:

```bash
# 1. Credentials — .env.test.example says where each value lives.
cp .env.test.example .env.test.local   # then fill it in

# 2. Check before connecting. Prints no secrets; reports which project each
#    URL names and what the guard would decide.
npx tsx tooling/scripts/check-test-env.ts

# 3. Schema. NOT `npm run db:migrate` — that loads .env.local (production).
npx tsx tooling/scripts/migrate-test.ts

# 4. Buckets. NOT `npm run storage:setup` — same reason.
npx tsx tooling/scripts/setup-storage-test.ts

# 5. Back to empty between runs, keeping the schema.
npx tsx tooling/scripts/reset-test-db.ts
```

Every one of those refuses to run unless the environment names
`zwnnqaryouevnzuwtyaj` and nothing else. `check-test-env` also catches a
publishable key pasted into the service-role slot, which otherwise fails much
later with an opaque permissions error.

### Free Nano is slow, and that is a real constraint

The test project runs on shared Free-tier compute in Tokyo. A chatty test — one
making a hundred sequential round-trips — can exceed a 30-second budget there
while finishing instantly against a local database, and the connection
occasionally drops or fails DNS resolution under load.

Do not respond by raising timeouts across the suite: that hides real slowness.
Run the complete suite in CI, where Supabase is local and round-trips cost
nothing. The hosted test project is for focused runs and for exercising the real
hosted behaviours — storage, auth, poolers — that a local stack only approximates.

### CI runs the full suite

`.github/workflows/ci.yml` runs on `main`, on pull requests, and on `verify/**`
branches. It builds its own Supabase stack with `supabase start`, so the whole
suite runs isolated and fast. Push a `verify/…` branch to get the complete gates
before anything reaches `main`.
