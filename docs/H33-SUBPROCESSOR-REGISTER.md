# H33 — Subprocessor register (verified actual services)

**Date of this register:** 2026-09-05
**Branch / commit read:** `verify/h33`, cut from `main` at `ff97c80`
**Production read (Part A, read-only):** Supabase project `anhgeeutrwftsvuzfinf` in
`aws-1-ap-northeast-2` (Seoul); Vercel project pinned to `icn1` (Seoul); domain
`www.idaraworks.com`.

This register lists every outside company that processes, or *could* process,
personal data on behalf of IdaraWorks customers. It was built from what the code
and the production configuration actually do — not from what the architecture
documents intended. Where a fact could not be read from this machine it is
marked **UNVERIFIED — owner action**.

**This is not legal advice and nothing here is "legally approved".** Every
clause that needs a qualified adviser is tagged `[LEGAL REVIEW]` with the
jurisdiction (UAE, KSA, or the customer's own). The vendor summaries below are
what the vendors' own pages said on 2026-09-05; they are not a substitute for
reading the documents before signing anything.

---

## 0. The one-paragraph version

Today exactly **two** companies process customer data: **Supabase** (the
database, sign-in, and file storage) and **Vercel** (the servers that run the
app). Both run in **Seoul, South Korea**. No email is sent, no error reports
leave the platform, no background-job service is connected, no AI provider is
connected, no billing provider exists, and social sign-in is switched off in the
code by default. Seven more services are listed in §3 with code written for
them: five (Resend, Inngest, Sentry, an AI provider, Upstash) would switch on
the moment a credential is set, social sign-in needs a flag plus dashboard
setup, and billing has no real adapter at all. Each is listed below with what it
would see and where it would put it — and that differs by service, so the
one-line summary is: Resend, Inngest and Anthropic store in the **United
States**; Sentry offers US or EU, chosen once; OpenAI processes in the US or EU
and, for select models, the **UAE**, with South Korea available as a
storage-only region; Upstash's region is chosen at database creation and is
**UNVERIFIED**; Google/Microsoft sign-in is global and not selectable. None of
them keeps data in Seoul beside the database, and only OpenAI offers anything in
the Gulf. That belongs in the customer conversation before any of them is
switched on.

---

## 1. How to read the tables

| Column | Meaning |
| --- | --- |
| **Active today** | **YES** = the production configuration read in Part A has the credential set and the code path runs. **NO** = the code exists but the credential is absent, so no data flows. |
| **Switch** | The environment variable(s) whose presence turns the service on. Setting it in Vercel is the act that creates a new subprocessor. |
| **What it would see** | Taken from the actual call site in the code, not from the vendor's marketing. |
| **Region** | Where the vendor says the data is processed and stored, with the page cited. |
| **Owner action to accept** | The steps only the account holder can take to make the relationship formal. |

"Personal data" here follows `docs/H30-PRIVACY-CHECKLIST.md` §1: account identity,
workforce records, customer contacts, typed content, uploaded files, and
behavioural records (audit and activity logs).

---

## 2. Active subprocessors — two

### 2.1 Supabase, Inc. — database (Postgres), sign-in (Auth), file storage (Storage)

| | |
| --- | --- |
| **Purpose** | Hosts the entire database, the sign-in system, and the two private file buckets. It is the system of record. |
| **What it sees** | Everything. Every table in the H30 checklist §1: emails, names, chosen language, password hashes and sign-in IP addresses (`auth.users` and the Auth logs), employee pay/leave/attendance, customer names/phones/emails/addresses, daily reports, document bodies, uploaded photos and signed copies, and the audit trail naming who did what. |
| **Region** | `aws-1-ap-northeast-2` — Seoul, South Korea. Supabase's region page states the chosen region "determines where your primary project data is stored" and that region choice is "a data-location control, not proof of regulatory compliance". The app's own S3 client defaults to `ap-northeast-2` (`src/platform/tenancy/storage.ts`, line 58). |
| **Active today** | **YES.** |
| **Switch** | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `DATABASE_URL`, `APP_DB_PASSWORD` (database); `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` (storage worker credential). |
| **Buckets** | `tenant-media` (private, 15 MB/file, images only) and `tenant-docs` (private, 25 MB/file, images only). Spec: `tooling/scripts/storage-spec.ts`; local mirror `supabase/config.toml` lines 47–55; policies in `supabase/migrations/0008_files_storage.sql`, `0009_files_hardening.sql`, `0114_h26a_document_foundation.sql`. No public bucket exists. |
| **Vendor DPA** | https://supabase.com/legal/dpa (also served at https://supabase.com/legal/customer-resources/data-processing-addendum). Incorporated by reference into the Terms — acceptance of the Terms "shall have the same effect as signing the SCCs" (§12.2). Subprocessor changes: at least 30 days' notice to subscribers; 5 days to object; termination of the affected service if unresolved. |
| **Vendor subprocessor list** | https://supabase.com/legal/customer-resources/subprocessor-list — the page holds a PDF ("Subprocessor List – Updated June 1, 2026") and a subscription form for change notices. The PDF itself was **not** fetched for this register. |
| **Data residency notes** | DPA §6.1: where the customer directs a region, data is "stored and primarily Processed in that region unless otherwise required"; Supabase may still process anywhere it "maintains facilities" for support and operations. Supabase's privacy policy (https://supabase.com/privacy) says data may be stored "in the U.S. or any other country in which Supabase or its affiliates … maintain facilities". Supabase's GDPR guide (https://supabase.com/docs/guides/security/gdpr-compliance) warns that backups, logs, exports, Edge Functions and sub-processors can all move data outside the chosen region. Backups: daily backups exist on Pro (7 days), Team (14 days), Enterprise (up to 30 days); point-in-time recovery is a paid add-on (https://supabase.com/docs/guides/platform/backups). **The backups page does not say which region backups are stored in.** |
| **UNVERIFIED — owner action** | (a) **Plan tier and PITR status** — the Supabase CLI on this machine has no access token, so neither could be read. Cross-reference O-1/O-2 in `docs/H30-OWNER-CHECKLIST.md`. (b) **Which mail server sends sign-in emails.** Supabase Auth sends confirmation and password-reset emails itself. Its built-in sender is "not meant for production use", limited to 2 messages an hour and to team-member addresses (https://supabase.com/docs/guides/auth/auth-smtp). If a custom SMTP provider has been configured in the dashboard, that provider is an **active subprocessor today** for every sign-up and reset email and must be added to §2 of this register. (c) **Phone provider.** `supabase/config.toml` line 60 says a phone provider "is configured on hosted only (Twilio Verify)". No code in `src/` reads any `TWILIO_*` variable or calls phone sign-in, so the app never uses it — but if it is enabled in the dashboard, Twilio can still receive phone numbers through Supabase Auth's own endpoints. Check Authentication → Providers → Phone; disable it if it is on. |
| **Owner action to accept** | 1. Confirm the Supabase account holder accepted the Terms (the DPA rides on them) and file a dated PDF of the DPA. 2. Subscribe to subprocessor notifications on the list page. 3. Download the June 1, 2026 subprocessor PDF and file it beside this register. 4. Record plan tier, PITR status and backup retention window. 5. Record the auth mail server and phone-provider findings above. 6. `[LEGAL REVIEW — UAE / KSA]` Whether hosting in South Korea under EU Standard Contractual Clauses is an acceptable cross-border transfer basis for the UAE PDPL and the KSA PDPL, for each pilot customer's data. The product cannot answer this. |

### 2.2 Vercel Inc. — hosting, serverless functions, CDN

| | |
| --- | --- |
| **Purpose** | Runs the Next.js application: every page render, server action, API route, the PDF renderer (a Chromium binary bundled *inside* the function — no outside PDF service) and image processing (`sharp`, in-process). Vercel also stores the deployment, its build output, runtime logs, and all environment variables (the secrets). |
| **What it sees** | Every request in flight: IP address, user agent, URL path, cookies including the session token, form bodies, and every row the app reads from the database to build a page. Nothing is stored by design except runtime logs and build artifacts. The server logger redacts the keys `password`, `token`, `secret`, `apiKey`, `authorization`, `phone`, `email` (at the top level and one level nested) and the request headers `req.headers.cookie` and `req.headers.authorization` before a line is written (`src/platform/logger.ts` lines 14–36, the `redact` block); values embedded in free-text messages are not covered by that list. Vercel's own privacy notice (https://vercel.com/legal/privacy-policy) says it collects "End User IP address, location information derived from IP address, and system configuration information" and log files from visitors to hosted sites. |
| **Region** | `vercel.json` sets `"regions": ["icn1"]` — Seoul, South Korea (`ap-northeast-2`) per https://vercel.com/docs/regions. That page and https://vercel.com/docs/functions/configuring-functions/region confirm the `regions` key sets where functions execute; the default for new projects would otherwise be `iad1` (Washington, D.C.). **What is *not* in Seoul:** the CDN's 126 points of presence terminate connections worldwide and route to the nearest region; static assets are cached globally; the Vercel control plane, dashboard, logs and build pipeline are not region-pinned by that setting, and the DPA says Vercel processes "to and in the United States and anywhere else in the world where Vercel or its Subprocessors maintain data processing operations". |
| **Active today** | **YES.** |
| **Switch** | None — it is the deployment target. Every environment variable in §2 and §3 lives in Vercel's environment store. |
| **Vendor DPA** | https://vercel.com/legal/dpa — "legally binding upon Customer entering into the Agreement"; the page describes itself as covering **Enterprise and Pro plan** customers. Subprocessor list is published at security.vercel.com (not fetched); to receive change notices you must email privacy@vercel.com; 5 calendar days to object; sole remedy is termination without refund. Data deleted "within a commercially reasonable timeframe" after termination. |
| **Data residency notes** | Compute in Seoul; everything around it (logs, builds, control plane, CDN edges) global with the US named first. No Gulf region is used; `dxb1` (Dubai) exists in Vercel's region list as an option if a customer ever requires it — but the database would still be in Seoul, so moving compute alone would not change where data lives. |
| **UNVERIFIED — owner action** | (a) **Plan tier.** The DPA text names Pro and Enterprise. If the team is on Hobby, confirm with Vercel whether the DPA applies at all before a pilot customer enters real data. (b) **Dashboard-side features that would add processing:** Web Analytics, Speed Insights, Log Drains, and Observability integrations. None is in the code — `@vercel/analytics` is not in `package.json`, and Vercel's own quickstart (https://vercel.com/docs/analytics/quickstart) requires adding that package to a Next.js app, so Web Analytics cannot be collecting anything today. Log Drains, however, are configured purely in the dashboard and would ship every log line (with IP addresses) to a third party. Confirm none is configured. (c) **Failover.** Automatic function failover to another region is described as an Enterprise feature; what happens to a Hobby/Pro deployment pinned to `icn1` during a Seoul outage was not verified. |
| **Owner action to accept** | 1. File a dated copy of the DPA and confirm the plan makes it applicable. 2. Email privacy@vercel.com to subscribe to subprocessor notices. 3. Walk the project settings for Analytics / Speed Insights / Log Drains / Integrations and record the result here. 4. `[LEGAL REVIEW — UAE / KSA]` US-based processing of request logs containing IP addresses and of the control plane, under SCCs. |

---

## 3. Conditional subprocessors — code present, switched off, nothing flows today

Summary first; detail follows.

| Service | Switch (env var) | What it would see | Where it stores data | Active today |
| --- | --- | --- | --- | --- |
| Resend (email) | `RESEND_API_KEY` | Recipient emails, subjects, bodies (invite links, signing links, campaign text) | United States (sending region selectable; storage is not) | NO |
| Inngest (background jobs) | `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` | Event names + org/entity/user UUIDs; two free-text `reason` fields typed by users; function run logs and return values | United States (AWS/GCP) | NO |
| Sentry (error reports) | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | Stack traces, request path, user/org UUIDs, browser info | United States (Iowa) or EU (Frankfurt), chosen once | NO |
| AI provider (Anthropic or OpenAI) | `FEATURE_IDARA_INTELLIGENCE=1` + `AI_ANTHROPIC_API_KEY` / `AI_OPENAI_API_KEY` (or `AI_BYOK_KEK`) | Prompt content: tenant business records across HR, finance, sales, documents; user messages | Anthropic: inference global or US, at-rest US only. OpenAI: US/EU processing; UAE for select models; other regions storage-only | NO |
| Billing provider | `BILLING_PROVIDER` (no real adapter exists) | Billing contact, plan, card data (held by the provider) | Not chosen | NO |
| OAuth sign-in (Google, Microsoft) | `OAUTH_ENABLED=true` + provider set up in Supabase Auth | That a person signed in; returns the email address (both) and, for Google, `profile`-scope claims (name/picture inferred from the scope, not stated by the cited page) | Global (not selectable) | Default off in code — production env UNVERIFIED |
| Upstash Redis (rate limiting) | `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Rate-limit keys containing IP addresses and, on some paths, email addresses | Region chosen at database creation — UNVERIFIED | NO |

### 3.1 Resend — transactional email

**Code.** `src/platform/notifications/email.ts`. With `RESEND_API_KEY` set it
POSTs `{from, to, subject, text}` to `https://api.resend.com/emails` through
`fetchWithPolicy` (10-second timeout). Without the key it logs at debug level and
returns `delivered: false`. The sender defaults to `IdaraWorks <onboarding@resend.dev>`
— Resend's shared test domain — unless `EMAIL_FROM` is set; production needs a
verified `idaraworks.com` sender.

**Where it is called (three places, all found by grep).**

| Call site | Recipient | Content |
| --- | --- | --- |
| `src/platform/auth/identity.ts` line 257 — workspace invite | The invited person's email | "You have been invited…" plus the invite link (a bearer token, valid for `INVITE_TTL_DAYS`) |
| `src/modules/crm/consent.ts` line 355 — CRM campaign send | Customer contacts who have recorded consent | Subject and body written by the tenant, with a STOP footer — this is the tenant emailing *their* customers through IdaraWorks |
| `src/modules/docstudio/signatures.ts` line 401 — signature request | External signer's email | Document reference and title, a personal signing link, the expiry |

`src/workers/functions/subscription-worker.ts` line 62 notes dunning-reminder
email as "the disabled seam" — it does not send.

**What Resend would see.** Email addresses of staff, of the tenant's customers'
contacts, and of outside signers; message text that can carry names, document
titles and one-time links. Resend states it stores "message content, delivery
logs, webhook payloads, and account records" (https://resend.com/security/gdpr).

**Region.** Sending regions are `us-east-1`, `eu-west-1`, `sa-east-1`,
`ap-northeast-1` (Tokyo) — https://resend.com/docs/dashboard/domains/regions.
The same page says the region "does not control where customer data is stored";
storage is in the United States regardless.

**Vendor DPA.** https://resend.com/legal/dpa — effective on accepting the Terms
or on separate execution; 14 days' notice of subprocessor changes; silence is
acceptance; data deleted within 90 days of termination; transfers under SCCs and
the EU-U.S. Data Privacy Framework. Subprocessor list:
https://resend.com/legal/subprocessors (last updated 2026-08-27; **22 entries,
all USA**: AWS, Anthropic, Attio, Cloudflare, Datadog, Elastic, Estuary, Google,
Inngest, Liveblocks, Metabase, Not Just Tickets, PlanetScale, Retool, RunPod,
Salesforce, Snowflake, Stripe, Supabase, Svix, Tinybird, Vercel).

**Owner action to accept.** 1. Create the account, accept the Terms (the DPA
rides on them), file a dated copy. 2. Verify the `idaraworks.com` sending domain
and set `EMAIL_FROM`; choose Tokyo as the sending region for Gulf/Korea latency
while noting storage stays in the US. 3. Subscribe to subprocessor notices.
4. Notify customers per §7 *before* setting `RESEND_API_KEY`. 5. `[LEGAL REVIEW —
UAE / KSA]` US storage of email content, including the tenant's own customers'
contact addresses and consent-based marketing sends. 6. Flip this row to
**YES** in the same change.

### 3.2 Inngest — background jobs (crons and event consumers)

**Code.** `src/platform/events/inngest.ts` creates the client `idaraworks` with
`eventKey: process.env.INNGEST_EVENT_KEY` ("undefined → dev mode"). Without
`INNGEST_SIGNING_KEY`, `/api/inngest` answers `503 inngest_unconfigured`.
Runbook: `runbooks/inngest-provisioning.md`. The consequence today, from Part A:
11 `domain_event` rows in production sit unprocessed with `attempts = 0`, all
from one organisation on 2026-09-01, because the relay that would deliver them
(`outbox-relay`, `src/workers/functions/outbox-relay.ts`) is itself an Inngest
cron. The stalled-job analysis is the companion document
`docs/H33-INNGEST-READINESS.md` (referenced by `docs/H33-TRUTH-MAP.md`).

**What Inngest would see.** Every event name and payload sent by the app, and
the run history of every function. The payload schemas in
`src/platform/events/registry.ts` (lines 48–247) mostly carry organisation,
actor and entity **UUIDs** and short tokens — a search of that file found no
`email`, `name` or `phone` field — **but two schemas carry free text typed by a
user**: `JobStageReopenedData.reason` (line 85, up to 500 characters) and
`DailyReportReturnedData.reason` (line 201, up to 2,000 characters). Whatever a
manager writes when reopening a stage or returning a daily report — which can
include an employee's name or any other personal detail — would reach Inngest
verbatim inside the event. Inngest also stores what each function *returns* and
the output of each step; `src/workers/index.ts` registers **28** functions in
`workerFunctions` (`imageDerivatives` through `idaraScheduleSweep`, defined
across the 15 files in `src/workers/functions/`), and whether any of them returns
a value containing personal data was **not** reviewed line by line —
**UNVERIFIED — owner action** before provisioning: have each worker's return
value checked, or make them return only identifiers, and decide whether the two
`reason` fields are truncated, replaced by a reference, or accepted as-is before
the relay is switched on.

**Region.** Inngest's security page (https://www.inngest.com/security): "All of
our services are hosted with Amazon Web Services (AWS) and Google Cloud Platform
(GCP)"; data is on AWS databases "located in the United States"; SOC 2 Type II;
encryption at rest and TLS in transit. No region choice is documented; the
alternative Inngest itself offers is self-hosting (https://www.inngest.com/docs/self-hosting).

**Vendor DPA — NOT FOUND on public pages.** `https://www.inngest.com/legal/dpa`
returned 404. The Terms (https://www.inngest.com/terms) reference only the
privacy policy; the privacy policy (https://www.inngest.com/privacy) names AWS
as hosting and lists no subprocessors and no DPA. The security page points to
https://trust.inngest.com/ for reports and to hello@inngest.com. **UNVERIFIED —
owner action:** obtain a DPA and a subprocessor list from Inngest before setting
the keys. `[LEGAL REVIEW]` Whether a queue service with no published DPA can be
used for a Gulf customer's data even when payloads are identifiers only.

**Owner action to accept.** Cross-reference O-6. 1. Request the DPA and
subprocessor list via trust.inngest.com. 2. Review worker return values (above).
3. Notify customers per §7. 4. Follow `runbooks/inngest-provisioning.md` §1–§4
(the four verification steps, including the unsigned-request rejection test).
5. Flip this row to **YES**.

### 3.3 Sentry — error reporting

**Code.** Server and edge: `src/platform/observability/sentry.ts` — every
function is a no-op without `SENTRY_DSN`; `sendDefaultPii: false`;
`tracesSampleRate: 0`; `beforeSend` runs `scrubEvent`, which deletes cookies,
request body, query string and all headers except `x-request-id`, reduces the
user to an id, and strips breadcrumb data and messages. Browser:
`src/instrumentation-client.ts` and `src/platform/observability/sentry.client.ts`,
loaded only when `NEXT_PUBLIC_SENTRY_DSN` is set; `next.config.ts` then adds the
DSN's ingest origin to the CSP `connect-src`. Runbook:
`runbooks/sentry-provisioning.md`.

**What Sentry would see.** Exception messages and stack traces, the request path
(query removed), request id, user id (UUID), organisation id, worker name, and
for dead-letters the event ids and names. Two honest limits of the scrub: (1) it
does not rewrite the *text* of a thrown error, so an error message that embeds an
email or a name would arrive as-is; (2) the browser SDK reports browser and OS
details and Sentry receives the sender's IP address at ingest — whether Sentry
*stores* it depends on a project setting that was not checked (**UNVERIFIED —
owner action**).

**Region.** Two choices, made once at organisation creation and never
changeable: United States (Iowa) or European Union (Frankfurt). Account,
organisation settings and audit logs are always stored in the US regardless
(https://docs.sentry.io/organization/data-storage-location/). No Asia or Gulf
option.

**Vendor DPA.** https://sentry.io/legal/dpa/ (v5.1.0, 29 May 2024) — accepted
by electronic opt-in, with a formal-execution process available; 30 days' notice
of new subprocessors; objection gives a termination right. Subprocessors:
https://sentry.io/legal/subprocessors/ (AWS, Google Cloud, Cloudflare, Anthropic,
OpenAI, Intercom, Mailgun, SendGrid, and Sentry affiliates in Austria, Canada,
the Netherlands).

**Owner action to accept.** Cross-reference O-7 ("decide whether"). If yes:
1. Choose the storage location deliberately — `[LEGAL REVIEW — UAE / KSA]`
neither US nor EU is local; which is the lesser transfer problem for your
customers is a legal question. 2. Accept the DPA and file it. 3. In the project
settings, turn off IP-address storage and confirm `sendDefaultPii` stays false.
4. Run the seeded-error check in the runbook and confirm no cookies, bodies or
headers arrived. 5. Notify customers per §7 before setting the DSN. 6. Flip this
row to **YES**.

### 3.4 AI provider — Anthropic API or OpenAI API (Idara Intelligence, H28)

**Code.** `src/platform/ai/registry.ts` is a closed list: `disabled`,
`deterministic` (an in-platform test provider that makes no external call),
`openai` (host `api.openai.com`, key `AI_OPENAI_API_KEY`) and `anthropic` (host
`api.anthropic.com`, key `AI_ANTHROPIC_API_KEY`). The adapters
(`src/platform/ai/adapters/anthropic.ts`, `openai.ts`) each state they "only ever
talk to" that one host and are "unverified against the live endpoint until
credentials exist". All calls pass through `src/platform/ai/gateway.ts`.
`src/platform/ai/gate.ts` requires, in order: `FEATURE_IDARA_INTELLIGENCE` set to
exactly `"1"`, the organisation's policy not disabled, the platform switches
open, and a provider available *to that organisation* — which in turn requires
an administrator to have recorded, in `src/platform/ai/privacy.ts`, the lawful
basis, the processor agreement reference, the transfer mechanism, and a
minimisation confirmation for that provider. `AI_BYOK_KEK` lets an organisation
supply its own key instead of a platform key.

**What the provider would see.** This is the widest exposure in this register:
the assembled prompt, which is tenant business content drawn from whichever
domains the organisation has *not* restricted — the restrictable list is
`hr_payroll`, `finance`, `tax`, `sales`, `customer_success`, `documents`,
`operations`, `project`, `reporting`, `administration`, `executive` — plus the
user's typed messages. An organisation can narrow this itself; it cannot widen
it beyond the operator's setting.

**Region and retention, from the vendors' pages.**

| | Anthropic | OpenAI |
| --- | --- | --- |
| Training on API data | "Anthropic may not train models on Customer Content from Services" (https://www.anthropic.com/legal/commercial-terms); "Retained data is never used for model training without your express permission" (https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) | Not used for training by default since 1 March 2023 unless the customer opts in (https://developers.openai.com/api/docs/guides/your-data) |
| Retention | Standard retention per Anthropic's commercial retention policy (the registry recorded 30 days on 2026-09-03); zero data retention by arrangement, some models excluded | Abuse-monitoring logs up to 30 days; zero data retention only with prior OpenAI approval |
| Where inference runs | `inference_geo`: `"global"` (default) or `"us"` at 1.1x price (https://platform.claude.com/docs/en/manage-claude/data-residency) | Processing regions: United States, Europe; **United Arab Emirates supports storage and processing for select models**; non-US regions need approval and carry roughly a 10 % uplift |
| Where data rests | Workspace geo: `"us"` is currently the only option, fixed at workspace creation | Storage-only regions include Australia, Canada, Japan, India, Singapore, South Korea, United Kingdom |
| DPA | https://www.anthropic.com/legal/data-processing-addendum — incorporated into the Commercial Terms; "reasonable notice" of new subprocessors, 15 days to object | https://openai.com/policies/data-processing-addendum/ — **that HTML page returned 403 to this machine**; the PDF at https://cdn.openai.com/pdf/openai-data-processing-addendum.pdf was readable and states OpenAI acts as processor, keeps a subprocessor list, and gives notice with a right to object |

**Active today.** **NO** — the flag is off and no key is set (Part A;
`docs/H30-OWNER-CHECKLIST.md` O-13).

**Owner action to accept.** 1. Decide whether AI is offered at all (O-13).
2. Pick one provider; accept its terms and DPA; file dated copies. 3. Decide the
geography: `[LEGAL REVIEW — UAE / KSA]` OpenAI's UAE region for select models is
the only in-Gulf option found anywhere in this register; Anthropic offers US or
global. 4. Request zero data retention if the customer base requires it.
5. Have each organisation's administrator complete the in-product privacy
register before the provider becomes usable for them (the code enforces this).
6. Notify customers per §7 before setting a key. 7. Flip this row to **YES**.

### 3.5 Billing provider — none exists

**Code.** `src/platform/billing/adapter.ts`. The `ProviderName` type names
`fake | stripe | paddle | lemonsqueezy | tap | moyasar`, but only two
implementations exist: a network-free **fake** for tests and demos, and
**disabled**, which refuses every operation and accepts no webhook. In
production (`APP_ENV=prod`) the default is disabled; `BILLING_PROVIDER=fake`
would select the fake and must never be set in production. **Activating a real
provider requires writing an adapter — an environment variable alone cannot do
it.** No card data is held anywhere (H30 checklist §1 "Not held").

**Active today.** **NO.** No DPA is cited because no vendor has been chosen;
when one is, its DPA and PCI attestation are added here first.

**Owner action.** Decision D1 (merchant of record). Cross-reference O-10: tell
the pilot that nothing can be charged. `[LEGAL REVIEW — KSA / UAE]` Choice of
processor (Tap and Moyasar are the regional candidates already named in the
type) and the customer-facing billing terms.

### 3.6 OAuth sign-in — Google and Microsoft (Entra ID)

**Code.** `src/platform/auth/oauth.ts` — `oauthEnabled()` is true only when
`OAUTH_ENABLED === "true"`; default off, buttons hidden.
`src/app/(auth)/actions.ts` lines 82–113 — `OAUTH_PROVIDERS = {"google", "azure"}`;
the action refuses when the flag is off, rate-limits the kickoff, then calls
Supabase Auth `signInWithOAuth` with a callback to `/auth/callback`. The provider
must *also* be configured with a client id and secret in the Supabase dashboard
(https://supabase.com/docs/guides/auth/social-login/auth-google,
https://supabase.com/docs/guides/auth/social-login/auth-azure).

**What they would see and return.** Google and Microsoft learn that a holder of
one of their accounts signed in to IdaraWorks (the callback URL identifies the
app). What comes back is stated here **by scope**, because the cited Supabase
pages name scopes rather than returned fields. Google: Supabase requires
`openid` plus `userinfo.email` and `userinfo.profile` (the last two "added by
default"), so an email address is returned and — **inferred from the `profile`
scope, not stated on the cited page** — basic profile claims such as name and
picture; Google's own OpenID Connect documentation, which would confirm the
exact claim list, was not fetched for this register. Microsoft: Supabase
requires the `email` scope ("Azure returns a valid email address"), and a
`provider_refresh_token` is issued only if `offline_access` is also requested;
the cited page lists no other returned field. These providers act mostly as the *user's own* account providers
rather than as processors for IdaraWorks — `[LEGAL REVIEW]` whether to list them
as subprocessors or as third-party identity providers in the customer-facing
list; this register lists them so nothing is hidden.

**Region.** Global; not selectable.

**Active today.** The code default is **off**. The production Vercel environment
could not be read from this machine, so **UNVERIFIED — owner action:** confirm
`OAUTH_ENABLED` is absent from the Vercel production environment and that no
provider is enabled under Supabase Authentication → Providers. The quick check
is whether `www.idaraworks.com/login` shows any "Continue with Google/Microsoft"
button; it should not.

**Vendor terms.** Google: https://developers.google.com/terms/api-services-user-data-policy
(requires a published privacy policy that "fully documents how your application
interacts with user data", minimal scopes, limited use). Microsoft:
https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA.

**Owner action to accept.** Keep off for the pilot unless a customer requires
it. If enabling: publish a privacy policy that meets Google's policy, complete
the OAuth consent-screen verification, configure the provider in Supabase, set
`OAUTH_ENABLED=true`, and record it here.

### 3.7 Upstash Redis — rate limiting (listed because the runbooks say it is coming)

**Code.** `src/platform/http/rateLimit.ts`. With both `UPSTASH_REDIS_REST_URL`
and `UPSTASH_REDIS_REST_TOKEN` set, every rate-limited action (`login`,
`signup`, `password_reset`, `otp_send`, `invite_send`, `invite_accept`,
`health`, `share`, `share_pdf`, `webhook`) sends `INCR`/`EXPIRE` on the key
`rl:<scope>:<identifier>` to Upstash. Without them, an in-memory window is used
(per instance; resets on deploy). The header comment of `rateLimit.ts` (line 4)
says the hosted app "MUST have Upstash configured before pilots, tracked in
OA-4", and `src/app/(auth)/actions.ts` (lines 66–67, inside `requestMeta()`)
repeats that "Rate-limiting durability still requires Upstash before pilots —
tracked in OA-4" — so this is the conditional service most likely to become
active first.

**What it would see.** The identifiers in those keys: the caller's **IP
address**, and on the login path the **email address** when no IP is available
(`meta.ip ?? email`). Nothing else.

**Region.** **UNVERIFIED** — Upstash's compliance page
(https://upstash.com/docs/common/help/compliance) covers SOC 2, ISO 27001, GDPR,
HIPAA, PCI, vulnerability scanning, backups (snapshots to AWS S3) and
encryption. It says **nothing** about the EU-U.S. Data Privacy Framework, and it
does not describe region selection at all — so whether a region can be chosen,
and which regions exist, is not known from any page read for this register.
Confirm at database creation and record the region here.

**Vendor DPA.** https://upstash.com/trust/dpa.pdf (April 2025) — incorporated by
reference into the Terms; subprocessor list at
https://trust.upstash.com/subprocessors and
https://upstash.com/static/trust/subprocessors.pdf; notice of changes.

**Owner action to accept.** 1. At database creation, record whether a region
can be chosen at all; if it can, pick the one nearest Seoul and record it here.
2. File the DPA. 3. Notify customers per §7.
4. Set the two variables. 5. Flip to **YES**. `[LEGAL REVIEW]` Storing IP
addresses and occasional email addresses with a US company for up to the window
length (at most one hour under `RATE_RULES`).

### 3.8 Seams that exist with no vendor at all (nothing to accept yet)

| Seam | File | State in production |
| --- | --- | --- |
| Document malware scanning | `src/platform/files/scan.ts`, `SCAN_PROVIDER` | Only `passthrough` and `disabled` exist; production default is **disabled**, which *rejects* document uploads rather than trusting an unscanned file. No vendor. |
| E-invoice clearance (ZATCA / UAE) | `src/platform/einvoice/adapter.ts`, `EINVOICE_PROVIDER` | Only `fake` and `disabled` exist; production default **disabled** — "no government portal" is contacted. When a clearance partner is chosen it becomes both a subprocessor and a transmission to a tax authority. `[LEGAL REVIEW — KSA]` |
| SMS / phone verification | `.env.example` lists `TWILIO_*` | No code in `src/` reads them. See §2.1(c) for the dashboard-side check. |
| Scheduled HTTP cron | `src/app/api/cron/idara/route.ts`, `CRON_SECRET` | `vercel.json` has no `crons` key, so nothing calls it. |

---

## 4. Things that are *not* subprocessors, checked so nobody has to ask

- **PDF rendering** — a Chromium binary (`@sparticuz/chromium` driven by
  `playwright-core`) runs *inside* the Vercel function (`src/platform/documents/pdf.ts`).
  No document leaves to a PDF service.
- **Image processing** — `sharp`, in-process. No image service.
- **Fonts** — `src/app/layout.tsx` imports `Geist` and `Geist_Mono` from
  `next/font/google`. Next.js downloads these at **build time** and self-hosts
  them: "No requests are sent to Google by the browser"
  (https://nextjs.org/docs/app/api-reference/components/font). The CSP in
  `next.config.ts` sets `font-src 'self'`, which would block a runtime Google
  Fonts request if one were ever added.
- **Browser-side third parties** — the CSP `connect-src` allows only the app
  itself, the Supabase host (https and websocket), and the Sentry ingest origin
  *when configured*. `img-src` allows the app, blobs, data URIs and the Supabase
  host. A browser running IdaraWorks cannot send data anywhere else.
- **Outbound calls from the server** — every call site of `fetchWithPolicy`
  (the mandated wrapper) was enumerated: `rateLimit.ts` (Upstash) and
  `email.ts` (Resend). The AI adapters use an injected fetch to their single
  host. The only raw `fetch(` in application code is a same-origin document
  preview. The Supabase JS client and the S3 client talk to the Supabase host.
  The Sentry and Inngest SDKs would talk to their vendors when configured.
- **Government URLs in the code** (`zatca.gov.sa`, `tax.gov.ae`, `mof.gov.ae`,
  `u.ae`, `gosi.gov.sa`, `hrsd.gov.sa`, `sdaia.gov.sa`, `address.gov.sa`,
  `uaelegislation.gov.ae`) are citation strings in the H29 country packs
  (`src/platform/country/packs/ae.ts`, `sa.ts`). Nothing fetches them.
- **GitHub** holds the source code and, per `runbooks/secret-rotation.md`, the
  service-role key in the `migrations` CI environment. It holds no customer
  records. It is a privileged vendor, not a processor of customer personal data
  — `[LEGAL REVIEW]` whether your customer-facing list should still name it.
  GitHub's terms were not fetched for this register.
- **DNS / registrar for `idaraworks.com`** — sees DNS queries only. Which
  company hosts the zone was not read from this machine — **UNVERIFIED — owner
  action** to record it.
- **Operator-side tooling.** During the H30–H33 audits, development assistants
  operated by the owner read production business records (for example the
  PO-002 line items and organisation names) to write the reports. That is
  processing by the operator's own tools, not by the product. `[LEGAL REVIEW]`
  Whether such tools need to appear in the customer-facing disclosure, and what
  the operator's own rule for pasting customer data into them should be.

---

## 5. Where the data is — one table

| Service | Status | Compute | Storage | Selectable? |
| --- | --- | --- | --- | --- |
| Supabase | Active | Seoul (`ap-northeast-2`) | Seoul; backup region not stated by vendor | Yes, at project creation |
| Vercel | Active | Seoul (`icn1`) for functions; global CDN edges | Logs/builds/control plane: US and global per DPA | Compute yes; the rest no |
| Resend | Off | Tokyo available for *sending* | United States only | Sending yes; storage no |
| Inngest | Off | US (AWS/GCP) | United States | No (self-host is the alternative) |
| Sentry | Off | US or EU | US (Iowa) or EU (Frankfurt); account metadata always US | Once, at creation |
| Anthropic | Off | Global or US | US only | Inference yes; rest no |
| OpenAI | Off | US, EU, UAE (select models) | Several storage-only regions incl. South Korea | Yes, with approval |
| Upstash | Off | UNVERIFIED | UNVERIFIED | UNVERIFIED — the cited compliance page does not describe region selection; record at database creation |
| Google / Microsoft sign-in | Off (code default) | Global | Global | No |

The single most useful sentence for a customer: **today their data is in Seoul
and nowhere else; every additional service on this list would put some of it
outside Korea — in the United States for most of them, with the exceptions in
the table above — and they will be told before that happens.**

---

## 6. What a pilot customer must be told

Extends `docs/H30-PRIVACY-CHECKLIST.md` §7 (points 1 and 5) and closes O-8.

1. Supabase and Vercel process their data, both in Seoul, South Korea. Backups
   and vendor operations may touch other regions under the vendors' own terms.
2. No other company receives their data today: no email is sent, no error
   reports, no background-job service, no AI, no billing, no social sign-in.
3. The services in §3 may be switched on later. Most of them store data in the
   United States; Sentry can instead use the EU; OpenAI offers UAE processing
   for select models and South Korea as a storage-only region; Upstash's region
   is not yet known; Google/Microsoft sign-in is global (§5 has the table). They
   will be told in advance, in writing, naming the service and its region, with
   the notice period written into the DPA (O-3), and may object.
4. Sign-in emails, if any arrive, come from Supabase's mail path — see §2.1(b);
   tell them which provider once it is verified.

`[LEGAL REVIEW — UAE / KSA]` The wording of this disclosure and whether Gulf
customers require in-region processing for any category (for example employee
records under the KSA PDPL) that would rule out §3 services outright.

---

## 7. Change-control rule — adding, changing or removing a subprocessor

This rule binds the operator. It exists because the *act* of adding a
subprocessor is one `vercel env add` — trivial to do and easy to forget to
disclose.

1. **Register first, credential second.** No environment variable that turns on
   a §3 service (or any new one) is set in Vercel until a pull request updating
   this register has merged. The row must carry: purpose, exact call site(s),
   what it sees, region, the vendor DPA URL with the date it was read, and the
   accepted-DPA filing reference.
2. **Vendor DPA accepted and filed** before the credential is set — a dated copy,
   not a link. For a vendor with no public DPA (Inngest today), a signed one from
   the vendor.
3. **Customers notified before, not after.** Every pilot customer receives
   written notice naming the service, its region, and the data category, at
   least the notice period written into the customer DPA (O-3) before the
   credential is set. `[LEGAL REVIEW]` The period itself — the vendors here use
   14 days (Resend) and 30 days (Supabase, Sentry); the customer DPA should not
   promise less than the shortest notice IdaraWorks itself receives.
4. **Public list updated** (O-8) on the same day as the credential.
5. **Verify, then flip the row.** Where a runbook has a verification step
   (`runbooks/inngest-provisioning.md` §4, `runbooks/sentry-provisioning.md` §3),
   run it and record the result; then change "Active today" to **YES** with the
   date.
6. **Removal** reverses the order: credential removed, row marked inactive with
   the date, customers told, and the vendor's deletion window recorded (Resend:
   90 days; Vercel: "commercially reasonable"; others: check the DPA).
7. **Re-read at every phase gate.** The "Active today" column is re-derived
   from the production environment at each H-phase closure; a mismatch between
   this register and the environment is a launch blocker, not a documentation
   task.
8. **Dashboard-side additions count.** Anything enabled in a vendor dashboard
   that ships data onward — Supabase custom SMTP or phone provider, Vercel Log
   Drains or Analytics, Sentry integrations — is a subprocessor change and
   follows steps 1–5.
9. **Vendor notices in.** Subscribe to every vendor's subprocessor-change
   notice (Supabase list page; Vercel via privacy@vercel.com; Resend, Sentry,
   Upstash per their pages). A vendor's change that affects region or category
   is passed on to customers under step 3.

---

## 8. How this register was built

**Read in the repository (branch `verify/h33`):**

- `src/platform/notifications/email.ts` — Resend seam and the dev sink.
- `src/platform/events/inngest.ts` — Inngest client, event-key gating;
  `src/platform/events/registry.ts` — payload schemas, lines 48–247 (checked for
  personal-data fields; the two free-text `reason` fields at lines 85 and 201 are
  called out in §3.2).
- `src/workers/index.ts` — the `workerFunctions` array (28 registered functions,
  `imageDerivatives` … `idaraScheduleSweep`) and the 15 files in
  `src/workers/functions/` they are defined in (counted; return values not reviewed).
- `src/platform/observability/sentry.ts`, `src/platform/observability/sentry.client.ts`,
  `src/instrumentation-client.ts` — Sentry gating and the PII scrub.
- `vercel.json` — `regions: ["icn1"]`, no `crons`.
- `next.config.ts` — CSP (`connect-src`, `img-src`, `font-src`), server-external packages.
- Bucket definitions: `tooling/scripts/storage-spec.ts`, `tooling/scripts/setup-storage-test.ts`,
  `supabase/config.toml` (lines 47–60), `supabase/migrations/0008_files_storage.sql`,
  `0009_files_hardening.sql`, `0114_h26a_document_foundation.sql`.
- `src/platform/tenancy/storage.ts` — S3 endpoint and region default.
- `src/platform/ai/registry.ts`, `gate.ts`, `gateway.ts`, `privacy.ts`,
  `adapters/anthropic.ts`, `adapters/openai.ts` — AI provider closed registry and gating.
- `src/platform/billing/adapter.ts` — billing seam (fake/disabled only).
- `src/platform/auth/oauth.ts`, `src/app/(auth)/actions.ts` — OAuth gating.
- `src/platform/http/rateLimit.ts`, `src/platform/http/fetchWithPolicy.ts` — Upstash seam and the outbound wrapper.
- `src/platform/files/scan.ts`, `src/platform/einvoice/adapter.ts` — vendor-less seams.
- `src/platform/documents/pdf.ts` — in-process Chromium. `src/app/layout.tsx` — fonts.
- `src/platform/logger.ts` — redaction list. `src/platform/env.ts` — `isProd()`.
- `src/platform/auth/identity.ts`, `src/modules/crm/consent.ts`,
  `src/modules/docstudio/signatures.ts` — the three email call sites.
- `src/workers/functions/subscription-worker.ts` — the only worker mentioning email.
- `.env.example` (never `.env.local` or `.env.test.local`).
- `runbooks/inngest-provisioning.md`, `runbooks/sentry-provisioning.md`, `runbooks/secret-rotation.md`.
- `docs/H30-PRIVACY-CHECKLIST.md`, `docs/H30-OWNER-CHECKLIST.md`, `docs/H33-TRUTH-MAP.md`.
- `package.json` — confirmed `@vercel/analytics` absent; `@sentry/nextjs`, `inngest`,
  `@sparticuz/chromium`, `playwright-core` present.

**Searches run across `src/`:** every `process.env.*` name; every `https://`
host string; every `fetchWithPolicy(` and raw `fetch(` call site; `signInWithOtp`
/ phone paths (none); `TWILIO` (none in code); `next/font/google`.

**Production facts** were taken from Part A of `docs/H33-TRUTH-MAP.md` and the
task brief as ground truth; no database connection was opened and no CLI
command that changes anything was run.

**Vendor pages fetched on 2026-09-05** (all official vendor domains):

| Vendor | Pages |
| --- | --- |
| Supabase | https://supabase.com/legal/dpa · https://supabase.com/legal/customer-resources/data-processing-addendum · https://supabase.com/legal/customer-resources/subprocessor-list · https://supabase.com/docs/guides/platform/regions · https://supabase.com/docs/guides/platform/backups · https://supabase.com/docs/guides/auth/auth-smtp · https://supabase.com/docs/guides/security/gdpr-compliance · https://supabase.com/privacy · https://supabase.com/docs/guides/auth/social-login/auth-google · https://supabase.com/docs/guides/auth/social-login/auth-azure |
| Vercel | https://vercel.com/legal/dpa · https://vercel.com/legal/privacy-policy · https://vercel.com/docs/regions (served for `/docs/edge-network/regions`) · https://vercel.com/docs/functions/configuring-functions/region · https://vercel.com/docs/analytics/quickstart |
| Resend | https://resend.com/legal/dpa · https://resend.com/legal/subprocessors · https://resend.com/docs/dashboard/domains/regions · https://resend.com/security/gdpr |
| Inngest | https://www.inngest.com/security · https://www.inngest.com/terms · https://www.inngest.com/privacy (DPA page: 404) |
| Sentry | https://sentry.io/legal/dpa/ · https://sentry.io/legal/subprocessors/ · https://docs.sentry.io/organization/data-storage-location/ |
| Anthropic | https://www.anthropic.com/legal/commercial-terms · https://www.anthropic.com/legal/data-processing-addendum · https://platform.claude.com/docs/en/manage-claude/api-and-data-retention · https://platform.claude.com/docs/en/manage-claude/data-residency |
| OpenAI | https://developers.openai.com/api/docs/guides/your-data · https://cdn.openai.com/pdf/openai-data-processing-addendum.pdf (HTML DPA page: 403) |
| Upstash | https://upstash.com/trust/dpa.pdf · https://upstash.com/docs/common/help/compliance |
| Google / Microsoft / Twilio | https://developers.google.com/terms/api-services-user-data-policy · https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA · https://www.twilio.com/en-us/legal/data-protection-addendum |
| Next.js | https://nextjs.org/docs/app/api-reference/components/font |

**Could not be fetched or was not fetched:** Inngest DPA (no public page found);
OpenAI DPA HTML page (403; PDF used instead); Supabase's subprocessor PDF (link
found, file not opened); Vercel's subprocessor list at security.vercel.com;
GitHub terms; the DNS provider; Google's own OpenID Connect claim documentation
(so §3.6 states what Google returns by scope, from the Supabase page); any
Upstash page describing region selection (none is linked from the compliance
page, so the Upstash region stays UNVERIFIED).

**Revision, 2026-09-05 (same day, after an independent fact-check):** worker
count corrected to 28 registered functions (was "17"); Resend subprocessor list
corrected to 22 entries with the 2026-08-27 date; the Data Privacy Framework
claim attributed to Upstash's compliance page withdrawn; the Upstash "MUST"
citation moved to `rateLimit.ts` line 4 with the exact `actions.ts` wording;
logger redaction range corrected to lines 14–36 including the two
`req.headers.*` paths; registry schema range corrected to 48–247 and the two
free-text `reason` fields named; the §0, §5 and §6 residency summaries rewritten
so they no longer say every conditional service is US-only; the §5 Upstash row
changed from "Yes" to UNVERIFIED; Google/Microsoft returned data restated by
scope. Nothing else changed.

---

## 9. Owner actions from this register, consolidated

| # | Action | Where |
| --- | --- | --- |
| SP-1 | Record Supabase plan tier, PITR status, backup retention window | Supabase dashboard (ties to O-1, O-2) |
| SP-2 | Record which mail server sends Supabase Auth emails; if a custom SMTP is set, add it to §2 | Supabase → Authentication → SMTP |
| SP-3 | Check the phone provider; disable if on | Supabase → Authentication → Providers → Phone |
| SP-4 | Subscribe to Supabase subprocessor notices; download and file the June 1, 2026 PDF; file the DPA | Supabase list page |
| SP-5 | Confirm Vercel plan makes the DPA applicable; email privacy@vercel.com to subscribe; file the DPA | Vercel |
| SP-6 | Walk Vercel project settings for Analytics, Speed Insights, Log Drains, Integrations; record none | Vercel dashboard |
| SP-7 | Confirm `OAUTH_ENABLED` is absent in production and no Auth provider is enabled | Vercel env + Supabase Auth; glance at `/login` |
| SP-8 | Record the DNS provider for `idaraworks.com` | Registrar |
| SP-9 | Before Inngest (O-6): obtain a DPA and subprocessor list; review the return values of all 28 registered workers; decide what happens to the two free-text `reason` event fields (§3.2) | trust.inngest.com |
| SP-10 | Before Sentry (O-7): choose US or EU deliberately; turn off IP storage; run the seeded-error check | Sentry |
| SP-11 | Before Resend: verify the sending domain, set `EMAIL_FROM`, choose Tokyo, file the DPA | Resend |
| SP-12 | Before Upstash: record the region; file the DPA | Upstash |
| SP-13 | Publish the customer-facing list (O-8) from §2 and §6, and adopt §7 as the standing rule | Owner |
| SP-14 | Take every `[LEGAL REVIEW]` line in this document to a qualified adviser for the UAE and KSA before a pilot customer enters real data (ties to O-3, O-4, O-9) | Counsel |

---

## 10. Legal review index

Every clause tagged `[LEGAL REVIEW]` above, in one place, so counsel can be
briefed from a single list:

1. §2.1 — Seoul hosting under SCCs as a transfer basis for UAE PDPL and KSA PDPL.
2. §2.2 — US processing of request logs (IP addresses) and the Vercel control plane.
3. §3.1 — US storage of email content including customers' contact addresses and consent-based sends.
4. §3.2 — Using a queue vendor with no published DPA, even for identifier-only payloads.
5. §3.3 — Choosing between US and EU storage for error reports.
6. §3.4 — AI geography: OpenAI's UAE region versus Anthropic's US/global.
7. §3.5 — Billing processor choice and customer billing terms (KSA / UAE).
8. §3.6 — Whether identity providers are listed as subprocessors or third parties.
9. §3.7 — Storing IP and occasional email addresses with a US rate-limit store.
10. §3.8 — E-invoice clearance partner as subprocessor and tax-authority transmission (KSA).
11. §4 — Whether GitHub appears on the customer-facing list.
12. §4 — Operator-side tooling that has read production records.
13. §6 — Disclosure wording; whether any Gulf data category requires in-region processing.
14. §7 — The customer-DPA notice period for new subprocessors.

None of these has been reviewed. This register records the position; it does
not approve it.
