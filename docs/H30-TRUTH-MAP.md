# H30 — Launch Hardening and Release Readiness: truth map

What is actually true about IdaraWorks on the eve of a controlled pilot, written
before anything was changed. Every claim here is either a file in this
repository, a row read from production, or a command whose output is quoted.

Mandate: owner direction, 2026-09-04 (overnight autonomous run).
Baseline: production application commit `4aef8c7`, `main` at `bb42fcb`
(documentation only on top), working tree clean, branch `verify/h30` cut from it.

---

## A.1 Production baseline, read at the start

`GET https://www.idaraworks.com/api/health`:

```
ok: true            commit: 4aef8c750573a2dd3043078502c82c1f97a3f191
db:      ok, 126 ms
storage: ok, 397 ms
queue:   ok, 12 ms — unprocessed 11, oldest_unprocessed_age_s 276434, dead_lettered 0, alert false
inngest: unconfigured — INNGEST_SIGNING_KEY / INNGEST_EVENT_KEY not provisioned
```

Two facts in that block matter for launch and are carried into Part E as
findings, not as background:

- **Eleven queued jobs have been unprocessed for 3.2 days and the health check
  says `alert: false`.** A queue that is permanently behind and reports itself
  content is not monitoring.
- **Inngest is unprovisioned**, which is why the queue never drains. This is the
  root cause of the "LPO PDF pending render" message that H22 recorded as
  permanent, and it affects every approved purchase order in production.

Database counts at baseline (from the H29 smoke, unchanged by it): 40
organisations, 61 users, 51 customers, 93 jobs, 78 invoices, 646 audit rows.

Migrations: 133 files on disk, 133 applied in production (0001–0133).

---

## A.2 Feature flags — every one, and its exact accepted value

Every flag is read in `src/platform/flags.ts` as `process.env.X === "1"`. The
string `"1"` and nothing else enables a flag: `"true"`, `"yes"`, `"on"` and `1`
with whitespace all read as off. This was verified by reading all nine
accessors rather than by sampling.

| Flag | Gates | Production |
| --- | --- | --- |
| `FEATURE_STOCK_SURFACES` | stock screens and goods-receipt posting | see A.7 |
| `FEATURE_HR_SURFACES` | HR, attendance, leave, payroll | see A.7 |
| `FEATURE_FINANCE_SURFACES` | accounting, banking, VAT, tax papers | see A.7 |
| `FEATURE_MANAGEMENT_STUDIO` | H25 planning studio | see A.7 |
| `FEATURE_DOCUMENT_STUDIO` | H26 document authoring | see A.7 |
| `FEATURE_REVENUE_STUDIO` | H27 CRM and revenue | see A.7 |
| `FEATURE_IDARA_INTELLIGENCE` | H28 AI platform | **off** — and to stay off |
| `FEATURE_COUNTRY_PACKS` | H29 country and establishment surfaces | **off** — and to stay off |
| `FEATURE_LOCALE_ES` | Spanish in the language switcher | **off** — and to stay off |

---

## A.3 External services and the credential each needs

| Service | Variable(s) | State |
| --- | --- | --- |
| Supabase (database, auth, storage) | `DATABASE_URL`, `DIRECT_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_DB_PASSWORD` | provisioned |
| Vercel (hosting) | — | provisioned |
| Inngest (background jobs) | `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY` | **not provisioned** |
| Resend (transactional email) | `RESEND_API_KEY`, `EMAIL_FROM` | see A.7 |
| Sentry (error reporting) | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | see A.7 |
| Upstash Redis (rate limiting) | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | see A.7 |
| Billing provider | `BILLING_PROVIDER` | **none selected** — the disabled provider stands |
| Malware scanning | `SCAN_PROVIDER` | see A.7 |
| Electronic invoicing | `EINVOICE_PROVIDER` | none — H29, deliberately off |
| AI provider | `AI_NARRATION_PROVIDER`, `AI_BYOK_KEK` | none — H28, deliberately off |
| PDF rendering | `CHROME_EXECUTABLE_PATH` | bundled |
| Cron authentication | `CRON_SECRET` | see A.7 |

---

## A.4 Every database script and the environment it can reach

Seventy-one scripts under `tooling/scripts/` open a database connection or a
service-role client. Their guards:

| Guard | Count | Meaning |
| --- | --- | --- |
| `targetsOnlyProductionProject()` | 21 | positively identifies production before connecting |
| `targetsOnlyTestProject()` + `assertNotProduction()` | 6 | positively identifies the isolated test project |
| integration env loader | 11 | loads `.env.test.local` only |
| **no guard at all** | **26** | connects to whatever `.env.local` names, which is PRODUCTION |

### The verdict-object audit (working rule 7)

`targetsOnlyProject()` returns `{ ok, refs, problems }`. Read as a boolean it is
always truthy, so `if (guard)` is vacuous and `if (!guard)` is universal — the
bug H29 found in five places. **All 29 call sites were re-read individually. All
29 read `.ok`.** `check-test-env.ts` reads it 16 lines after the call, which a
naive window flags and a human does not; it is correct.

### The unguarded scripts, by what they can do

Classified by reading each one, not by its name:

| Script | Risk | Reality |
| --- | --- | --- |
| **`s7-cleanup.ts`** | **critical** | Deletes **every organisation** except two hard-coded UUIDs, plus their `user_profile` and `auth.users` rows. Dry-run by default. Today production has 40 organisations and the protected list names 2. See LB-1. |
| `s9-residue-purge.ts` | low | Dry-run by default; structurally restricted to orgs absent from `public.org`. |
| `setup-storage.ts` | medium | Loads `.env.local` and the service-role key; idempotent bucket configuration, not destructive. No positive identification of its target. |
| `s3`–`s10-prod-demo.ts`, `pta8-demo.ts`, `s11-pilot-sim.ts` | medium | Write demo data into whatever `.env.local` names. |
| `sim-seed.ts` / `sim-cleanup.ts` / `sim-verify.ts` | low | Carry their own `assertKnownProject()` and an explicit destructive flag. |
| `probe-db.ts`, `s7-inventory.ts`, `s5-perf-harness.ts`, `storage-spec.ts`, `test-residue.ts`, `platform-operator.ts` | low | Read-only or dry-run only. |
| `h22-prod-smoke.ts`, `h28`/`h29-ui-fixture.ts`, `h28`/`h29-ui-shots.ts` | medium | Write fixtures; rely on which env file the caller loaded. |

---

## A.5 Deferred defects inherited from H22–H29

| Id | From | What | State entering H30 |
| --- | --- | --- | --- |
| **PO-002** | H22 | Najolatech received 34 units across two goods receipts; **zero stock movements exist**. Root causes: the organisation has no warehouse and no stock location, and nothing in the product lets anyone create one. | open; owner deferred repair |
| **`po.grn_not_stocked`** | H22 | The banner tells the user to "check the warehouse setup and receive again". There is no warehouse setup screen, and "receive again" means a NEW receipt, which posts as new lines — it does not replay the failed one. | open, and actively misleading |
| **`po.pdf_pending`** | H22 | "LPO PDF pending render" is permanent, not pending: the Inngest worker that renders it never runs. | open |
| H24 transition ambiguities | H24 | Opening-balance conversion questions the owner has not ruled on. | open by owner decision; out of H30 scope |
| Historical accounting conversion | H24 | Not performed. | out of scope by standing instruction |
| D4, D5 (Saudi EOSA base, GOSI ceiling) | H29 | Unverifiable from official sources; encoded as configuration requiring review. | correct as designed |
| D2 (UAE phase dates) | H29 | Not encoded anywhere. | correct as designed |

`grep TODO|FIXME|HACK|XXX` across `src/` returns **zero** matches. Parked work
lives in the phase reports, not in code comments.

---

## A.6 Launch blockers found during the truth audit

| Id | Severity | Finding | State |
| --- | --- | --- | --- |
| **LB-1** | critical | `s7-cleanup.ts` deletes every organisation not in a two-entry hard-coded allow-list. The allow-list had gone stale and matched **zero of the 40** organisations in production, so one `--apply` would have deleted every tenant, including all four with real logins, and their `auth.users` rows. | **fixed** — rule inverted, `48a64fc` |
| **LB-2** | high | No warehouse or stock-location setup exists anywhere in the product. Receiving cannot be made to work by a user. | **fixed** — module + screen, `321ea95` |
| **LB-3** | high | The goods-receipt failure banner instructs an action that duplicates a receipt, and no action exists to replay the failed posting. | **fixed** — guided remedy, `321ea95` |
| **LB-4** | high | The health check raises `alert` only on a dead letter, which requires a worker that exists. Production sat 3.2 days with eleven unprocessed jobs reporting `alert: false`. | **fixed** — staleness alarm, `af95617` |
| **LB-5** | medium | `postGoodsReceiptToStock` read receipt lines with a bare `limit 500` and nothing checked the limit. A 501-line receipt posted 500 and reported success. | **fixed** — refuses, `321ea95` |
| **LB-6** | medium | `DocumentActions` carried no language on any link and the document route defaults to English, so an Arabic reader's "Download PDF" returned English. There was no route to an Arabic PDF at all from invoices, quotes or week plans. | **fixed** — `af95617` |
| **LB-7** | **high** | Production holds **zero** `unit_of_measure` rows and **35 stock items with no base unit**. `resolveReceiptTarget` skips any such line silently as "not an inventory item", so every goods receipt in the database would have failed to post even with a perfectly configured warehouse. This is the second cause of PO-002 and H22 never found it. | **fixed** — `2b721c2` |

### How LB-7 was found

By the H30 production smoke, which expected to see PO-002 in the unposted list
and saw nothing. The diagnostic that explains it is kept as
`tooling/scripts/h30-po002-diagnose.ts` (read-only):

```
unit_of_measure rows in the whole production database: 0
items with no base unit:                              35
```

Two lessons worth keeping. First, the H22 blocker document named the missing
warehouse and the receive-again trap and stopped there; the deeper cause was
underneath both, and a remedy built only from that document would have left
Najolatech exactly where it was. Second, the H30 remedy's own diagnostic
initially excluded these lines as "not stockable", which would have made it
blind to the one case it exists for. A smoke that asserts a specific expected
row found both.

### The root cause behind LB-4, and why it is not fixed here

Inngest is unprovisioned. That is why the queue never drains, and it is also why
`po.pdf_pending` — "LPO PDF pending render" — is permanent rather than pending on
every approved purchase order in production. Provisioning it needs an external
account and its credentials, which were not supplied: owner action **O-6**.

H30 fixed the part that was a defect (a monitor that could not see the failure)
and left the part that needs a credential clearly named.

---

## A.8 Audited and deliberately left alone

Recorded so a later reader does not re-open a settled question.

| Thing | Finding |
| --- | --- |
| Document Studio's PDF link carries no `lang` | **Correct.** That route ignores `lang` and renders the document's own stored language. An issued contract does not change language because of who opens it. |
| The revenue report PDF link carries no `lang` | **Correct.** That route reads the locale from the request cookie. |
| `src/app/(app)/o/[orgId]/jobs/[jobId]/errors.ts` has no auth | **Not an action file.** The string `"use server"` appears in a comment explaining why it is a plain module. |
| `/f/<token>` and `/sign/<token>` actions have no session auth | **Correct by design.** The token is the authority and every one is rate-limited per IP. |
| `/api/health` and `/api/ready` are unauthenticated | **Correct.** Both are rate-limited, cached, and expose no secret. |
| Seat and active-work limits | **Enforced server-side**, recounted inside the transaction under a per-organisation advisory lock, so neither can be raced and neither depends on a hidden button. |
| The 1,000-row PostgREST ceiling | **Does not apply.** Reads go through a direct postgres connection, not PostgREST. Now proved rather than assumed — `h30-pagination-scale.test.ts` walks 1,150 rows. |
| 26 database scripts with no environment guard | Re-read individually. `s7-cleanup.ts` was the only destructive one without positive identification and is fixed; `sim-*` carry their own `assertKnownProject()`; the rest are dry-run, read-only, or write fixtures under a caller-chosen env file. |

---

## A.9 What H30 did not touch, by instruction

PO-002's actual stock repair (owner action **O-11** — the remedy is built and
proved; running it changes a live customer's records), the H24 transition
ambiguities, historical accounting conversion, the H29 country and locale flags,
H28 AI, and H31/H32.

---

## A.7 The production flag state, read rather than inferred

This section originally said the production environment could not be read. It
can: the Vercel CLI on this machine is authenticated, and the project's variable
**names and targets** (never values) are readable through its API.

All 14 project environment variables are scoped to the `production` target and
to nothing else. The `FEATURE_*` variables that exist are:

| Flag | Defined in production |
| --- | --- |
| `FEATURE_STOCK_SURFACES` | yes |
| `FEATURE_HR_SURFACES` | yes |
| `FEATURE_FINANCE_SURFACES` | yes |
| `FEATURE_MANAGEMENT_STUDIO` | yes |
| `FEATURE_DOCUMENT_STUDIO` | yes |
| `FEATURE_REVENUE_STUDIO` | yes |
| `FEATURE_COUNTRY_PACKS` | **not defined** |
| `FEATURE_LOCALE_ES` | **not defined** |
| `FEATURE_IDARA_INTELLIGENCE` | **not defined** |

Two consequences worth stating. H28's and H29's flags are absent rather than set
to something falsy, which is the strongest form of off. And because every
variable is production-only, a **preview** deployment runs with no feature flags
and no database credentials — which is why previews are harmless, and why a
preview build must never be promoted to production: it would carry none of them.

Values were not read and are not claimed. A variable being defined does not prove
it holds the exact string `"1"` that the accessors require.

---

## A.10 Why the final commit did not deploy itself

`main` reached `57a89ed` (code identical to the CI-green `5a63020`; the
difference is one documentation file). Production continued serving `9842df2`.

Read from Vercel directly rather than guessed:

| Project | Last deployment | Commit | Target |
| --- | --- | --- | --- |
| `idaraworks` (serves www) | 08:40 | `5a63020` | **preview** |
| `idaraworks-bfsc` | 08:48 | `5a63020` | **production** |
| `idaraworks-cd61` | 08:48 | `5a63020` | **production** |
| `idaraworks-wfft` | 08:40 | `5a63020` | preview |
| `idaraworks-bfs` | 08:40 | `5a63020` | preview |

Two sibling projects built the *same commit* to *production* from the same push
to `main`, so the GitHub integration was working at that moment. The project that
serves the site did not — it had already built that exact SHA eight minutes
earlier as a preview of `verify/h30`, and Vercel does not build one commit twice
within a project.

Everything else checks out: `productionBranch` is `main`, the project is not
paused, there is no ignored-build-step command, the team is not blocked, and 71
of the 100 daily Hobby deployments were used.

**The working practice that caused it:** pushing a verification branch and then
fast-forwarding the identical commit to `main` means Vercel sees the SHA twice
and builds it once, as whatever target it saw first. H29 escaped this by
coincidence of timing. A future phase should either merge with a merge commit,
or accept that the promotion is a manual step.

Nothing about `57a89ed` deployed either, on any project — consistent with the
integration going quiet after 08:48. That part is not fully explained here, and
is recorded as unexplained rather than guessed at.
