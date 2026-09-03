# H28 — Idara Intelligence: truth map

Facts before code. Parts A–F were written before the first H28 change; Part G is
the progress and evidence log kept while building. Nothing here rewrites a
historical roadmap claim; the approved mandate is recorded in
`phase2/14-POST-MVP-AMENDMENTS.md` §7 and the binding agent contract in
`docs/architecture/ROLE_AWARE_AGENT_ARCHITECTURE.md` (amended by H28, see F).

## A. Baseline (read-only, 2026-09-03)

| Fact | Value | Source |
| --- | --- | --- |
| Working tree | clean on `main` at `00579da` (H27 shipped at `17ba434` + docs); branch `verify/h28` created from it | `git status`, `git log` |
| Production | `/api/health` ok, commit `17ba434`, db/storage/queue true; HEALTHY per `prod-health.ts` (127 applied, 0 pending, 244 tables, 0 without RLS) | health endpoint, health script |
| Migrations | local files 0000–0127 (127 files; number 0093 was never used), ledger 127 applied; next number **0128** | `ls supabase/migrations` |
| Flags in Vercel production | `FEATURE_DOCUMENT_STUDIO`, `FEATURE_FINANCE_SURFACES`, `FEATURE_HR_SURFACES`, `FEATURE_MANAGEMENT_STUDIO`, `FEATURE_REVENUE_STUDIO`, `FEATURE_STOCK_SURFACES` (all `"1"`); no `FEATURE_IDARA_INTELLIGENCE` | `vercel env ls production` (names only) |
| AI provider credentials | **none** in production, preview, development or `.env.local`; no AI SDK dependency in `package.json` | env listings, `package.json` |
| Existing agent substrate | H12/A1 `src/platform/agents/*`: closed registry of ten H11 agents, six action classes, eight read-class tool definitions, typed request/output contract with citation ground truth, ONE provider seam (`DisabledAgentProvider` default, `DeterministicTestProvider` for tests, 30 s timeout, cancellation), secret-free context builder, fail-closed entitlement gate `feat.ai_agents` (deliberately unregistered → false everywhere), approval-binding validator, audited runner. No tables of its own; audit through `command()` as entity `agent`. | files read in full |
| Consumers of that substrate | H27 `crm/intelligence.ts`, H26 `docstudio/ai.ts`, H25 `studio/advisor.ts` (each fails closed and publishes an owner action), H14 workspace blueprint schema/compiler/validate (agent relevance ⊆ allow-list), H15 onboarding `recommendAgents`, public homepage showcase (H13: exactly the ten canonical agents with installed portraits, tests pin the set and the "planned" wording) | grep |
| Public truth line | north star §7: "Powered by AI" prohibited until a real production agent runs behind a tested capability flag; `AI_AGENTS_PRODUCTION_READY = false` asserted by unit test | north star, `agent-foundation.test.ts` |

## B. The mandate, condensed (owner, 2026-09-03; binding)

1. **One ambient Idara Dock** in the authenticated shell, never in the nav
   sidebar: movable launcher with non-drag positioning, remembered per
   user/device, safe-area aware, quiet status, keyboard reachable, no focus
   trap, three progressive states (quick ask → working window → deep
   workspace), minimise with a progress chip, mobile bottom sheet, shortcut and
   command-palette entry, context capsule with explicit record sharing.
2. **One entry, many specialists**: Idara routes to governed specialists (at
   least the twelve named domains); agents reuse the authorised domain
   services; every agent carries purpose, owner, version, instructions,
   knowledge domains, tools, capability class, permissions, approvals, cost and
   sensitivity classes, enabled state, evaluation version, change history,
   retirement and replacement; delegation bounded, traced, cost-limited, with a
   stored plan and parent/child run graph.
3. **Provider-neutral gateway** server-side: provider and model registries,
   capability and regional metadata, effective-dated price book, usage
   categories, timeouts, idempotent retries, circuit breakers, health,
   fallback policy, structured validation, streaming, background execution,
   cancellation, size limits, model retirement. Keys server-side only; no
   permanent binding to one vendor; failover claims only after adapter-boundary
   tests.
4. **No provider**: fail closed, no external calls, no fabricated results,
   provider-dependent agents unavailable with the exact owner action; ship the
   platform behind a strict flag.
5. **Grounding**: answers cite records, dates, assumptions, gaps, method,
   identity and kind (answer / suggestion / draft / proposed action); retrieval
   through existing services only; "not enough evidence" over invention.
6. **Tools by risk class** (read-only, draft, reversible, material, restricted)
   with preview (what, records, old/new, permission, external communication,
   cost, reversibility, side effects) and human confirmation that re-checks
   identity, permission, version and prerequisites, refuses drift, uses
   idempotency keys and existing services, and reports honestly.
7. **Human control**: the platform never approves its own work, signs, files
   tax, releases payments, posts uncontrolled journals, finalises payroll,
   hires or dismisses, changes permissions, sends campaigns, deletes history,
   resolves legal or accounting ambiguity, changes production configuration or
   hides uncertainty; the existing approval engine and separation of duties
   apply.
8. **Conversations, tasks, memory**: persistent conversations, named sessions,
   background tasks, plans, pause/cancel/resume, history, attachments and
   records, agent switching, branching; memory explicit and governed in
   separate stores; inspect/correct/delete; untrusted content never becomes
   instructions.
9. **Injection defence in layers**, with adversarial tests for indirect
   injection, cross-tenant retrieval, tool escalation, secret requests and
   confirmation bypass.
10. **Metering before any paid model**: every request records organisation,
    user, agent, conversation, run, provider, model and version, token
    categories, tool extras, provider request id, latency, status and retries,
    actual and estimated cost with price-book version, credits, currency and
    rate source, budget decision, timestamp; never an invented exchange rate.
11. **Entitlements and credits** separate from provider tokens; plans with
    allowances, limits, restrictions, soft and hard stops, overage rules,
    packs, BYOK, manual credits, effective dates and history; customer usage
    view; billing adapter that fails closed; no charging without the payment
    provider and legal setup.
12. **Owner economics dashboard** with drill-down and kill switches (org,
    agent, provider, model, global stop, budget with audit, export).
13. **Routing** transparent and recorded; small models for simple work; no
    silent assurance downgrade.
14. **Specialists** useful and evidence-backed without duplicating the app;
    **agent builder** for administrators (safe, versioned, never overriding
    security); **automations** through the existing engine and workers, quiet,
    deduplicated, muted or snoozed, recorded with cost; **outputs beyond
    chat** saved through explicit actions with sources; **voice and multimodal
    seams** provider-neutral and inactive; **privacy** recorded before any
    production use; **evaluations** versioned with thresholds; **EN/AR/RTL and
    accessibility parity**; **performance** with lazy loading proven;
    **security proofs** enumerated; **tests** across the listed gates with
    over 1,000 usage records and conversations; deterministic providers only.
15. **Deployment** behind `FEATURE_IDARA_INTELLIGENCE` (exact `"1"`), provider
    availability, organisation entitlement, agent state and the global stop;
    the fifteen-step sequence; hidden until the owner provisions a provider.
16. **Untouched**: historical accounting, H24 ambiguities, PO-002, H22 stock
    posting, real pricing and payments, provider contracts, production
    secrets, H29, genuine production data.

## C. Research consulted (primary sources unless marked)

### C.1 Provider privacy, retention and residency (fetched 2026-09-03)

| Provider | Training on API data | Retention | Residency | DPA |
| --- | --- | --- | --- | --- |
| OpenAI API | Not used to train "unless you explicitly opt in" | Abuse-monitoring logs up to 30 days; Zero Data Retention endpoint-specific and "subject to approval" | Regional hosts (`us.`, `eu.`, `ae.`, …) at a 10% uplift for newer models; non-US needs abuse-monitoring approval and a retention amendment | Enterprise privacy and DPA pages returned 403 to the fetcher; not verified from a fetched page |
| Anthropic API | "we will not use your inputs or outputs … to train" (Commercial Terms) | Deleted within 30 days; flagged content up to 2 years; ZDR per organisation via sales, some models excluded | `inference_geo` global or us (1.1x); workspace geo us only | DPA with SCCs incorporated into Commercial Terms |
| Google Gemini API | Paid tier: not used to improve products; unpaid tier: used | Paid: "limited period" for abuse detection (no day count); ZDR on approval | No residency control documented | DPA where Google is a processor |

Sources: developers.openai.com/api/docs/guides/your-data; privacy.claude.com articles 7996868, 7996866, 8956058, 7996862; anthropic.com/legal/commercial-terms; platform.claude.com/docs/en/manage-claude/api-and-data-retention and data-residency; ai.google.dev/gemini-api/terms, docs/zdr, docs/available-regions.

**Consequence (ADR-52):** the model registry stores per-model privacy metadata (training, retention, ZDR eligibility, residency knob) as facts with a source and date; the platform never claims zero retention, residency or "no training" beyond what the configured provider contract and endpoint provide; every claim surfaces on the customer privacy screen only when that provider is configured.

### C.2 Billing and usage metering (fetched 2026-09-03)

- OpenAI Responses usage: `input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens`; request id in header `x-request-id`; optional client `X-Client-Request-Id`; Usage and Costs admin APIs; `x-ratelimit-*` headers; list prices per model with no effective date published.
- Anthropic usage: `input_tokens` (tokens after the last cache breakpoint only), `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `service_tier`, `inference_geo`; header `request-id`; usage and cost admin APIs; `anthropic-ratelimit-*` headers with RFC 3339 resets; list prices per model with dated notes.
- Gemini `usageMetadata`: `promptTokenCount` (includes cached), `cachedContentTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`; body `responseId`; prices published future-dated.
- No provider documents an idempotency key; SDKs retry transient failures.

**Consequence (ADR-51, ADR-54):** usage is normalised to input / output / cache_read / cache_write / reasoning with provider totals derived per adapter; the gateway owns idempotency and assumes a retried call may be billed twice (retry count recorded); the price book is effective-dated with a source URL per row and is never inferred.

### C.3 Tool calling, structured outputs, streaming, caching

- OpenAI: `tools[{type:"function", name, parameters, strict}]`; `text.format={type:"json_schema", strict:true}`; SSE events (`response.output_text.delta`, `response.function_call_arguments.delta`, `response.completed`, `response.failed`, …); automatic prompt caching (≥1,024 tokens, 30-minute reuse window).
- Anthropic: `tools[{name, description, input_schema, strict}]`, `tool_choice`; `output_config.format={type:"json_schema"}` with constrained decoding (no recursive schemas, `additionalProperties:false`); SSE (`message_start`, `content_block_delta` with `text_delta` / `input_json_delta`, `message_delta` cumulative usage, `message_stop`); explicit `cache_control` breakpoints.
- Context windows differ by an order of magnitude between small and large models of each vendor; the registry records the documented figures per model with the fetch date.

**Consequence (ADR-50):** one gateway request shape (system, blocks, tools with JSON schema, response schema, limits) and one response shape (content blocks, tool calls, usage, request id, finish reason) with adapters translating; streaming normalised to a small event set; caching hints passed through as adapter-specific options.

### C.4 Prompt-injection defence (fetched 2026-09-03)

- OWASP LLM01:2025 (prompt injection), LLM05:2025 (improper output handling), LLM06:2025 (excessive agency) and the OWASP Top 10 for Agentic Applications 2026 (goal hijack, tool misuse, identity and privilege abuse, memory and context poisoning, insecure inter-agent communication, cascading failures, human-agent trust exploitation, rogue agents). genai.owasp.org.
- Anthropic guidance: third-party content only in tool results, labelled by type and source, declared untrusted in the system prompt, JSON-encoded; least privilege; screen tool outputs; red-team with injected documents. platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks.
- OpenAI Model Spec 2026-08-18: chain of command; tool outputs and quoted data have "no authority by default"; minimise irreversible side effects; seek approval before consequential actions. model-spec.openai.com.
- Microsoft MSRC 2025-07-29 (spotlighting: delimiting, datamarking, encoding; classifiers; deterministic exfiltration blocking; explicit approval); Google 2025-06-13 (classifiers, markdown and URL sanitisation, contextual confirmation, observable planning). MCP security best practices (no token passthrough, least-privilege scopes, logged elevation with correlation ids, SSRF controls, consent dialogs showing the exact command).

**Consequence (ADR-56):** layered controls implemented deterministically outside the model: trusted instruction hierarchy, provenance-labelled untrusted blocks, per-agent tool allowlists with strict schemas, output validation, tenant and permission checks in code, confirmation gates showing exact arguments, no URL fetching or shell, egress restricted to registered provider hosts, delegation depth and tool-call and cost caps, suspicious-instruction detection logged as flags, safe refusal.

### C.5 Human oversight and audit

- NIST AI RMF 1.0: accountability presupposes transparency; GOVERN 3.2 oversight roles, MAP 3.5 oversight processes, MEASURE 2.8 audit logs and override statistics, MANAGE 2.4 mechanisms to supersede, disengage or deactivate, MANAGE 4.1 appeal and override. NIST AI 600-1 companion (fragments only). EU AI Act Art. 14 (understand limitations, counter automation bias, disregard, override, reverse, stop button) and Art. 12 (automatic event logs over the lifetime; identification of the persons involved) used as design references, not compliance claims. ISO/IEC 42001 exists (page returned 403; not verified).

**Consequence (ADR-57):** every proposed action records timestamp, agent and version, tool and exact arguments, inputs and their provenance labels, the deciding person and decision, elevation with correlation id, outcome and incident communication; the global stop, organisation, agent, provider and model kill switches implement MANAGE 2.4.

### C.6 Accessibility patterns (fetched 2026-09-03, W3C primary sources)

- WCAG 2.2 (Recommendation 2024-12-12): **2.5.7 Dragging Movements (AA)** every drag operation needs a single-pointer non-drag alternative; **2.5.8 Target Size (AA)** 24×24 CSS px or 24 px spacing; **2.4.11 Focus Not Obscured (AA)** author content, including non-modal dialogs and sticky bars, must not entirely hide the focused element; **2.4.3 Focus Order** non-modal dialog controls sit in the focus order right after their opener, modal focus returns to the opener; **2.1.2 No Keyboard Trap** with Escape as a standard exit; **2.3.3** and `prefers-reduced-motion` (Media Queries 5). w3.org/TR/WCAG22, Understanding pages, w3.org/TR/mediaqueries-5.
- WAI-ARIA 1.2 and APG: modal dialog (`role="dialog"`, `aria-modal`, label, inert outside, Tab wraps, Escape closes, focus in on open and back on close); non-modal `dialog` without `aria-modal`; toolbar with arrow-key roving focus; menu button with `aria-haspopup`/`aria-expanded`; live regions (`status` polite, `alert` assertive, `log` for ordered additions); feed pattern for long lists. w3.org/TR/wai-aria-1.2, w3.org/WAI/ARIA/apg.
- W3C NAUR draft (2022): the entire conversation history must be reviewable; no response time limits; keyboard input.

**Consequence (ADR-58):** the launcher is a `toolbar` with a position menu (six logical positions, arrow keys) and a reset control; the working window is a non-modal `dialog` placed after the launcher in focus order with Escape to minimise; the deep workspace is a route; the transcript is a `role="log"`; state changes announce through one polite `status` region; errors through `alert`; every control at least 24 px, touch controls 44 px on field flows; reduced motion disables slide and pulse; the launcher never sits over the BottomNav band, the header band or a focused element (it yields when focus lands beneath it).

### C.7 UAE and KSA data considerations before a foreign AI provider (fetched 2026-09-03)

- **UAE Federal Decree-Law 45/2021 (PDPL)**: lawful basis (Art 4, consent by default with contract-necessity and other exceptions); minimisation and purpose limitation (Art 5); controller records including cross-border movement (Art 7); processor contract contents and erasure after processing (Art 8); breach notification (Art 9); DPO triggers including new technologies and automated processing (Art 10); transfers to adequate states or approved cases (Art 22) or with contractual safeguards, explicit consent or contract necessity (Art 23). Free zones: DIFC Law 5/2020 (adequacy, standard clauses, documented assessment) and ADGM DPR 2021. uaelegislation.gov.ae/en/legislations/1972; u.ae data-protection page; DIFC consolidated text; adgm.com.
- **KSA PDPL (M/19 as amended by M/148)** and Implementing Regulation: scope covers processing of residents' data from outside the Kingdom (Art 2); basis (Arts 5–6, legitimate-interest assessment Impl. Reg. Art 16); processor guarantees and contract contents including foreign-regulation exposure and sub-processors (Art 8, Impl. Reg. Art 17); minimisation and data maps (Art 11, Impl. Reg. Art 19); transfers (Art 29) with the 2024 Transfer Regulation (adequacy list, SCCs, binding common rules, certification, risk assessment) and SCC templates (controller-to-processor); DPO triggers and five-year records including transfer descriptions (Impl. Reg. Arts 32–33). sdaia.gov.sa documents; dgp.sdaia.gov.sa transfer regulation.

**Consequence (ADR-52, ADR-61):** the organisation privacy screen records, per configured provider: lawful basis chosen by the organisation, the processor agreement reference, the transfer mechanism, retention as published by the provider, minimisation rules applied (redaction of secrets, personal identifiers and unnecessary fields), the record-of-processing entry and the DPO check; until an owner completes this register for a provider, that provider stays unavailable to the organisation. Nothing here is legal advice; the screen states what the sources require and what the organisation recorded.

## D. Inventory: what already exists (reuse, never compete)

### D.1 AI seams, gates, metering, settings, palette, shell, identity (inventory 2026-09-03)

| Area | What exists | Status | H28 use |
| --- | --- | --- | --- |
| Agent substrate | `src/platform/agents/*` (H12/A1): `AGENT_IDS` (ten), `ACTION_CLASSES` (six), eight read tool definitions mapped to authz actions, `AGENT_TOOL_ALLOW`, typed contract, `DisabledAgentProvider` returned unconditionally by `getAgentProvider()`, `callProvider` (30 s timeout, abort), `buildProviderRequest` (secret shapes and every env value asserted absent; untrusted blocks labelled), `agentsEnabled()` false everywhere because `feat.ai_agents` is unregistered, `validateApprovalBinding`, `runAgentCore` (identity → gate → class → allow-list ∩ `can()` ∩ handlers → provider → structural and citation validation → one audit row) | shipped, no handlers, no provider | extend: registry gains governance fields and five ids; runner gains tool channel, delegation, metering; provider seam is backed by the gateway |
| Narration seam | `src/platform/ai/adapter.ts` (`getNarrationProvider`: fake outside prod, disabled in prod), `numbers-subset.ts` validator, `digest/service.ts` (`feat.ai_narration`, `limit.ai_credits_month`, `ai_interaction` credits) | shipped, disabled in prod | keep; route future narration through the gateway with the same validator |
| Onboarding classifier | `modules/onboarding/provider.ts` deterministic; platform daily spend breaker `app.platform_daily_ai_spend()` over `ai_interaction.cost_micros` with `AI_DAILY_SPEND_CAP_MICROS` (default 100,000,000,000 micros) | shipped | reuse the breaker as the platform ceiling; the global stop is a separate switch |
| H25/H26/H27 seams | `studio/advisor.ts` (`draftReviewNarrative` calls `provider.complete` directly with its own 20 s abort), `docstudio/ai.ts` (clauses, citation validation, `summariseDocument`, `askDocument`, `proposeObligations`), `crm/intelligence.ts` (`gatherCrmContext` redacted by `pricePrivileged`, `validateProposals`, `crmAssist`), each with the same owner-action sentence and `data-ai` markers | shipped, off | become tool handlers for the Document and Sales agents; availability follows the H28 gate |
| Usage ledger | `public.ai_interaction` (0046, widened 0050): org_id, feature (closed check), provider, model, input_tokens, output_tokens, credits, cost_micros, validator_verdict, status, subject, created_by, created_at; grants select+insert only; pruned by retention (0064) | shipped, append-only | **extended additively** (agent, conversation, run, step, model version, cache and reasoning tokens, provider request id, latency, retry count, actual and estimated cost with currency and price-book version, credits, rate source, budget decision) and the feature check widened; no second usage table |
| Billing-grade meters | `public.usage_event` (0054): meter_key, period_key, dedup_key unique per org, delta; append-only, negative deltas correct | shipped | AI credit consumption also posts a `meter` row per run (dedup by run id) so billing sees one number |
| Entitlements | catalogue `FEATURE_KEYS`/`LIMIT_KEYS` (includes `feat.ai_onboarding`, `feat.ai_narration`, `feat.ai_drafts`, `limit.ai_credits_month`, `limit.ai_onboarding_calls`), `resolveEntitlements` (plan → add-ons → overrides; 60 s cache), `hasFeature`, `checkLimit` (governs add, never see), `requireCapability`; add-on `addon.ai_pack` credential_gated (+200 credits, `feat.ai_narration`, `feat.ai_drafts`); `cap.*` keys seeded on every plan by each phase's migration; `feat.ai_agents` never registered (registering seeds it into the all-on trial) | shipped | `cap.idara` registered like `cap.revenue_studio` (nav/module presence only); AI availability is NOT an entitlement flag but the H28 policy row (`ai_entitlement`) plus the release flag; `feat.ai_agents` stays unregistered and `agentsEnabled()` is redefined over the H28 gate |
| Module gate | `ModuleGate` (blueprint state) per segment layout; release flags in `src/platform/flags.ts` (six one-liners, strict `"1"`), law tests `flags.test.ts` and `revenue-gate-law.test.ts` (page gates before the first await) | shipped | `idaraEnabled()` one-liner; same law test pattern for every H28 page, route and the dock mount |
| Org settings | `app_settings (org_id, key, value jsonb)` select/insert/update, `readBlob`/`writeBlob` in the config pipeline | shipped | org AI policy stored in `ai_entitlement` rows (history), not in settings |
| Per-user state | none (cookie `iw_sidebar`, locale cookie, one localStorage draft in the report composer) | gap | dock position per device in localStorage keyed by user; preferences in `ai_memory` scope user |
| Command palettes | three page-local palettes (revenue, documents, studio) each binding Ctrl/Cmd+K on their own surface; no global registry; Builder binds Ctrl+S/Z/Y | shipped | the dock registers its own shortcut (default Ctrl+. / Cmd+.) with a typing guard; "Ask Idara" command added to the three palettes' command lists |
| Shell | `src/app/(app)/o/[orgId]/layout.tsx`: root `min-h-dvh md:flex`, sticky sidebar (no z), header `sticky top-0 z-30`, mobile drawer `fixed inset-0 z-40`, BottomNav `fixed inset-x-0 bottom-0 z-20` with `pb-[env(safe-area-inset-bottom)]`, palettes and studio exit-focus `z-50`; main `pb-24 md:pb-8`; no toast or live region; one floating button (studio exit focus) | shipped | dock launcher `fixed z-40` (below palettes), avoids the BottomNav band on mobile and the header band; working window `z-40`; deep workspace a route; one polite live region owned by the dock |
| Identity and audit | `resolveCtx`/`resolveCtxForAction` (session, membership, MFA), `can`/`assertCan`, `command()` (read-only billing states refused; audit + activity + events in one transaction), inline audit writes lint-banned | shipped | every server action and route in H28 starts with `resolveCtxForAction`; every write goes through `command()` |
| Workers | Inngest fleet (`workerFunctions`, 26 functions) with `defineOrgFunction` (membership-verified ctx) and the platform-discovery sweep pattern (`app.orgs_with_crm_automations()` guarded by `app.assert_platform_task()`); **no Inngest keys in production**, so crons never fire there and the health check shows an ageing unprocessed queue | shipped, dormant in prod | background runs use a database queue executed by an Inngest function when configured and by an authenticated cron route otherwise (fails closed without its secret); documented as an owner action |
| Tests | vitest unit (98 files) and integration (globalSetup migrates TEST), guard-env refusing production, bleed harness enumerating every org-scoped table with a seeder registry, i18n noun law, `i18n-add.mjs`, Playwright walks and phase smoke scripts, dev preview scripts per phase (ports 3210–3214) | shipped | H28 adds seeders for every new table, `dev-idara-preview.mjs` on 3215, `h28-*` scripts |

### D.2 Automation, workers, approvals, notifications, permissions, files, documents, domain read services

| Area | What exists | H28 use |
| --- | --- | --- |
| Automation engine (H27) | `crm/automation.ts`: ten CRM triggers, recursive conditions through `platform/rules/conditions.ts`, six closed actions (assign owner, create task, notify, request approval which only notifies, flag risk, set forecast category), dry run claims occurrences in one batch, live run per subject under a savepoint, idempotency by `(automation, subject, occurrence_key, mode)`, `runEnabledAutomations(ctx)` for the sweep, `app.orgs_with_crm_automations()` discovery | not extended (CRM-specific, module-owned); H28 proactive work is a **schedule of agent runs** (`ai_schedule`) that produces notifications and saved outputs, never a second rule engine; CRM alerts stay in the H27 engine |
| Other engines | exception engine (14 rules, dedup keys, working calendar), approval rules, nightly digest per audience with the narration hook, document workflows and obligations reminders, outbox relay | the management briefing schedule composes the existing digest payloads and exception/attention feeds deterministically and narrates only when a provider exists |
| Workers | 26 Inngest functions; `defineOrgFunction` verifies `(org, actor)` membership and never grants cost or price privilege; platform crons open `createAppDb({max:1})` and use definer discovery guarded by `app.assert_platform_task()`; outbox at-least-once with dead letters; Inngest keys absent in production | background runs: `ai_run` queue + `idara-run-execute` (event) + `idara-schedule-sweep` (cron) registered in the fleet, plus an authenticated cron route for Vercel Cron that fails closed without `CRON_SECRET`; owner action documented |
| Approvals | `submitForApproval(tx, ctx, …)` in-transaction, `decideApproval` with rule scope, escalation up the role ladder, `SelfApprovalError`, guarded subject updates by `live` status, `afterDecide` hooks, `supersede…`; subject types closed in `APPROVABLE_TYPES` (15) with DB CHECKs widened per phase | new subject type `ai_action` (material actions), dispatch entry with `live: "awaiting_approval"`, `onApprove: "approved"`, `onReject: "rejected"`, `onWithdraw: "proposed"`; execution stays a separate, re-checked step by the requester |
| Notifications | `createNotificationIn`, recipient-private rows, kinds closed in `NOTIFICATION_KINDS` (16), preferences per user (channels only), inbox page with attention feeds; no mute, snooze or frequency; no email fan-out | kinds `idara_alert`, `idara_action_waiting`, `idara_run_finished`; mute and snooze per schedule in `ai_schedule_pref` (per user); dock badge counts unread `idara_*` notifications |
| Permissions | 171 actions in the matrix with the double-transcription guard; `can`/`assertCan`; viewer holds 11 read actions; money walls by `costPrivileged`/`pricePrivileged`; export redaction helper | new actions `idara.use`, `idara.actions.confirm`, `idara.agents.manage`, `idara.usage.view`, `idara.memory.manage` (org knowledge); every tool names the existing domain action it requires; the matrix data file and the expected file both extended |
| Files | access classes, `SignUploadInput` (image MIMEs only), `SCAN_PROVIDER` rejecting documents in production when unset, polymorphic attachments in `ATTACHABLE_TYPES` | attachments to a conversation reference existing `file` rows only (`ai_conversation` in `ATTACHABLE_TYPES`); nothing is sent to a provider unless the file is `ready`, scanned and listed in the context capsule |
| Document Studio | `documentClauses`, `summariseDocument`, `askDocument`, `proposeObligations`, `diffRevisions`, `listDocuments`, `getDocument`, obligations | Document and Contract Agent tools |
| Domain reads | CRM (`gatherCustomer360`, `gatherRevenue360`, `boardPage`, `computeForecast`, reports, `successOverview`, `myCommercialQueue`), jobs (`listJobs`, `getJobDetail`, `listStages`, `getWeekView`), studio (`portfolioSummary`, `scheduleForPlan`, `capacityForPlan`, `reviewPlan`), finance (`trialBalance`, `profitAndLoss`, `balanceSheet`, `cashPosition`, `arAgeing`, `budgetVsActual`, `journalEntryDetail`, `accountLedger`), tax (`prepareVatReturn` working papers, pack versions), HR (`leaveBalances`, `listLeaveRequests`, `hrAttentionFeed`, `listPayRuns`, `getPayRun`), inventory (`listStockLevels`, `listMovements`, `attentionFeed`, `itemStock`), exports catalogue | every read tool calls one of these through the module door with the acting user's ctx and archetype; no new SQL for facts |
| i18n | flat catalogs (4,501 keys), ICU with `term()` variables, Latin numerals, `i18n-add.mjs` (no em dash), noun law | all H28 copy through the tool; agent names and descriptions in both catalogs |
| Tests | bleed harness enumerating every `org_id` table (seeder registry), `markFixtureOrg`, residue script, per-phase smoke, walk, fixture, preflight scripts | seeders for every H28 table; `h28-*` scripts; the smoke proves no provider call with the flag off and on |

## E. Transition seams (exact)

1. `src/platform/agents/provider.ts` `getAgentProvider()` → returns a gateway-backed provider (`GatewayAgentProvider`) that resolves the organisation's route and meters the call, or the disabled provider when nothing is configured. Consumers (`crm/intelligence.ts`, `docstudio/ai.ts`, `studio/advisor.ts`) keep their call shape; `advisor.ts` moves from `provider.complete` to `callProvider`.
2. `src/platform/agents/gate.ts` `agentsEnabled(ctx)` → `idaraEnabledFor(ctx)`: release flag, organisation policy not disabled, no global or organisation stop, and a configured provider that the organisation's privacy register admits. `feat.ai_agents` stays unregistered.
3. `src/platform/agents/registry.ts`: `AGENT_IDS` gains `idara`, `customer_success`, `tax`, `document_contract`, `org_admin`; `manager` stays in the enum with `status: "retired"`, `replacedBy: "idara"`; `AGENT_DEFS` carries the governance fields; `AGENT_TOOL_ALLOW` covers the new ids; `A1_SUPPORTED_CLASSES` is superseded by the risk-class model in the tools registry while the H12 runner keeps working for the three existing seams.
4. `src/platform/workspace/{blueprint,compiler,validate}.ts`: enum keeps retired ids for stored blueprints; compiler resolves through `resolveAgentId`; validation warns `agent_retired`.
5. `src/app/_home/HomePage.tsx`: showcase reads `SHOWCASE_AGENT_IDS` (the H13 canonical ten) instead of `AGENT_IDS`; tests updated; public wording unchanged ("planned", `AI_AGENTS_PRODUCTION_READY = false`).
6. `public.ai_interaction`: additive columns and widened `feature` check (migration 0128); `app.platform_daily_ai_spend()` unchanged and now covers gateway calls.
7. `src/platform/registries.ts`: `APPROVABLE_TYPES` + `ai_action`; `AUDIT_ENTITY_TYPES` + `ai_conversation`, `ai_run`, `ai_action`, `ai_agent`, `ai_memory`, `ai_schedule`, `ai_entitlement`, `ai_provider`, `platform_operator`; `NOTIFICATION_KINDS` + three `idara_*` kinds; `ATTACHABLE_TYPES` + `ai_conversation`.
8. `src/modules/approvals/service.ts` `SUBJECTS` + `ai_action` with `afterDecide` → `onAiActionDecidedIn` (dynamic import of the idara door); DB CHECKs on `approval` and `approval_rule` widened (0128).
9. `src/app/(app)/o/[orgId]/layout.tsx`: mounts `<IdaraDockMount>` (server component that renders nothing unless the flag is on, the organisation policy admits the person and `idara.use` is held) after `<main>`; the launcher island is tiny, the workspace is `next/dynamic` with `ssr: false`.
10. Palettes: "Ask Idara" command appended to the three page palettes' command lists (opens the dock through a custom event).
11. `src/workers/index.ts`: `idaraRunExecute`, `idaraScheduleSweep` registered (fleet test updated).
12. Entitlement catalogue: `cap.idara` registered (presence only), seeded on every plan like `cap.revenue_studio`; `limit.ai_credits_month` reused as the plan allowance.
13. `tooling/scripts/seed-two-orgs.ts`: `H28_SEEDERS` for every new `org_id` table.

## F. Decisions (ADR-49 onward)

**ADR-49 — Layering.** `src/platform/ai/` (L1: gateway, adapters, models, price book, routing, budget, circuit, metering, credits, kill switches, prompts, evaluation dataset) imports only platform and lib. `src/modules/idara/` (door `service.ts`) owns conversations, messages, runs, steps, actions, memory, custom agents, schedules, saved outputs, the tool registry and the orchestrator, and calls other modules only through their doors. UI under `src/app/(app)/o/[orgId]/idara/*`, settings under `settings/ai`, the operator centre under `src/app/platform/ai`.

**ADR-50 — One gateway shape.** `GatewayRequest { orgId, userId, agentId, runId, stepId, purpose, system, blocks[] (provenance-labelled, JSON-encoded untrusted data), input, tools[] (name, description, JSON schema, riskClass), responseSchema?, maxOutputTokens, temperature?, cacheHint? }` and `GatewayResponse { content[] (text | tool_call), usage {input, output, cacheRead, cacheWrite, reasoning}, providerRequestId, model, finishReason, latencyMs }`. Adapters: `disabled`, `deterministic` (scripted, test only), `openai` (Responses API over `fetch`), `anthropic` (Messages API over `fetch`). No SDK dependency. Streaming normalised to `text_delta | tool_call | usage | done | error`. Egress limited to the registered host of each provider. Real adapters are contract-tested against recorded fixtures and a fake `fetch`; they are unverified against live endpoints until credentials exist, and the report says so.

**ADR-51 — Metering law.** Every gateway call, including failures, writes one `ai_interaction` row with the normalised usage, the provider request id, latency, status, retry count, the estimated cost in the provider's currency with the price-book row id, the credits charged and the budget decision. Actual provider cost is recorded only when a provider returns it (none does inline today) and is otherwise null, never guessed. Conversion to the organisation's base currency uses the finance module's governed rate when one exists for the day, else the row keeps `rate_source = "none"` and the customer view shows credits, not converted money.

**ADR-52 — Registries in code, state in tables.** `AI_PROVIDERS` and `AI_MODELS` are closed registries with capability, context, privacy (training, retention, ZDR eligibility, residency knob), status (`active | retiring | retired`, `replacedBy`) and a source URL with fetch date. `ai_provider_state` and `ai_model_state` hold the mutable enabled, health and breaker fields. `ai_price_book` is effective-dated per model with `source_url`, `recorded_by` and a version; seeded from the published list prices fetched on 2026-09-03; historical usage keeps its price-book row id.

**ADR-53 — Agent registry.** Fifteen ids: the ten H11 agents (nine active, `manager` retired and resolved to `idara`) plus `idara`, `customer_success`, `tax`, `document_contract`, `org_admin`. `AGENT_DEFS` carries purpose, owner, version, prompt file, knowledge domains, tools, capability class (`read | draft | action`), required actions, approval requirements, cost class, sensitivity class, default enabled, evaluation version, change history, status and replacement. Organisation-level enabled state lives in `ai_agent_state`. Display names follow the mandate ("Project and Planning", "Sales and Revenue", "HR and Payroll", "Data and Reporting", "Operations", "Inventory and Purchasing", "Accounting", "Finance"). Custom agents are versioned rows (`ai_agent`, `ai_agent_version`) built on a base agent and can only narrow it.

**ADR-54 — Entitlements and credits.** A credit is one US cent of estimated provider cost at the effective `ai_credit_policy` (platform, effective-dated), so providers can change without rewriting plans. Monthly allowance = the resolved `limit.ai_credits_month` (plan, add-ons, overrides) plus non-consumption ledger rows in the period; consumption = the period's `ai_interaction.credits`. `ai_entitlement` rows (effective-dated, append-only history) carry mode (`disabled | trial | included | prepaid | enterprise | byok`), daily and per-user and per-agent limits, model allow-list, maximum cost per request, soft-warning percentage, hard stop, overage allowed, restricted domains, reason and author. Budget decision order: global stop → provider, model, agent switches → organisation mode and limits → allowance (warn, then stop unless overage allowed) → platform daily spend breaker. Decisions are recorded on the usage row. No payment is ever collected; the billing adapter records intent and fails closed.

**ADR-55 — Platform operator.** `platform_operator (user_id, granted_by, note, granted_at, revoked_at)` is global, readable by the user for their own row, written only through the guarded script `tooling/scripts/platform-operator.ts` (owner action). `app.assert_platform_operator()` requires the `app.user_id` GUC to name an active operator and no organisation context; the operator reads (`app.ai_platform_*` definer functions) return cross-organisation aggregates and drill-down pages for the owner centre. Kill switches and budget changes are audited in `platform_audit` (global) with the operator's id.

**ADR-56 — Injection defence.** Trusted instruction hierarchy (platform contract → agent prompt file → organisation instructions (custom agent, validated) → user input → tool results, the last two never authoritative); every tool result is a JSON-encoded, provenance-labelled untrusted block; tool channel = allow-list ∩ `can()` ∩ risk-class policy with strict zod schemas; output validated structurally, citations checked against consulted records; tenant and permission checks in code; no URL fetching, no shell, no raw SQL; egress to registered provider hosts only; delegation depth ≤ 2, ≤ 4 children per run, ≤ 12 tool calls per run, ≤ 40 per root, per-run cost cap; a suspicious-instruction detector (both languages) logs `flag` steps and forces the "needs confirmation" path for any proposed action in that run; secrets asserted absent (H12); safe refusal text.

**ADR-57 — Actions.** Tools declare a risk class (1 read, 2 draft, 3 reversible, 4 material, 5 restricted). Class 1 runs inline; class 2 produces saved drafts; class 3 and 4 create `ai_action` rows with a preview (what, records, old and new values, required action, external communication, estimated cost, reversibility, side effects) and the record versions seen; confirmation re-checks identity, permission, version and prerequisites, refuses drift, executes through the owning module with an idempotency key and records the result; class 4 additionally submits an `ai_action` approval (existing engine, separation of duties) and executes only after approval by another person and a second explicit confirmation by the requester; class 5 never has a handler. Replay of a confirmed action is refused by the unique idempotency key and the state machine.

**ADR-58 — Dock.** The launcher is a `toolbar` fixed at one of six logical positions (start or end × top, middle, bottom) chosen by pointer drag with snap, by a position menu, or by arrow keys; position stored per user per device in localStorage with a reset control; it stays out of the header band, the BottomNav band on phones and yields when focus lands beneath it. Quick ask is a small non-modal dialog; the working window is a movable, resizable non-modal dialog (`z-40`, below palettes) with keyboard size presets; the deep workspace is the route `/o/[orgId]/idara`. On phones the working window is a bottom sheet and the workspace is full screen. One polite `status` region announces state, the transcript is a `log`, errors are `alert`. Shortcut default Ctrl+. (Cmd+.) with a typing guard, configurable per user; the three palettes gain "Ask Idara". The heavy workspace, charts and the canvas are `next/dynamic` with `ssr: false` and are absent from ordinary page bundles (asserted by a build-output test).

**ADR-59 — Execution.** Interactive runs execute inside the request and stream through an SSE route; a run that exceeds the interactive budget or is started as a task is queued (`ai_run.status = "queued"`) and executed by the worker (`idara-run-execute`, Inngest event) or by the cron route (`/api/cron/idara`, `CRON_SECRET`) when Inngest is not configured; cancellation sets `cancel_requested_at` and aborts between steps; pause and resume keep the plan; every step is a row in `ai_run_step`; the parent/child graph is `ai_run.parent_run_id`.

**ADR-60 — Delegation.** Idara plans with a deterministic bilingual intent classifier (domain keywords and the context capsule's record kind) and, when a provider is available, a structured model classification validated against the registry; it delegates to at most four specialists per run, depth two, never to an ancestor agent or a repeated (agent, input) pair inside the same root; each child runs under the same ctx and archetype; the merged answer names the answering agent and the contributors; cost accrues to the root run.

**ADR-61 — Privacy register.** `ai_privacy_register` per organisation per provider records lawful basis, processor agreement reference, transfer mechanism, published retention, minimisation confirmation, record-of-processing reference, DPO check, author and date; a provider is unavailable to an organisation until its register row exists; organisations can disable AI or restrict domains; secrets, personal identifiers and unnecessary fields are redacted before any block leaves the platform; the customer privacy screen shows only the configured provider's published facts.

**ADR-62 — Memory.** `ai_memory` rows (scope `user` or `org`, kind `preference` or `knowledge`) are written only by an explicit "remember" action or by an administrator; conversation content is never promoted silently; every row shows source, author and date and can be corrected or revoked by its owner (user) or an administrator (org); memories enter prompts as labelled blocks, never as instructions.

**ADR-63 — Evaluations.** `src/platform/ai/evals/dataset.v1.json` (synthetic, bilingual) with cases per category; the runner executes the real pipeline with the deterministic adapter and scores correctness, citation fidelity, permission enforcement, tenant isolation, refusal, hallucination, tool selection, preview accuracy, cost, latency, injection, stale data, missing evidence, provider failure and model regression; thresholds are code; the unit suite fails when a critical category fails; a custom agent version can be published only after its evaluation passes; model status changes require the contract tests and the evaluation suite green on the commit.

**ADR-64 — Release.** `FEATURE_IDARA_INTELLIGENCE` strict `"1"` gates the dock mount, every page, route and action; provider availability is per environment (`AI_OPENAI_API_KEY`, `AI_ANTHROPIC_API_KEY`, never shared across environments); organisation policy, agent state and the global stop are separate; `cap.idara` on every plan for presence only; production ships with the flag unset; nothing paid can run until an owner provisions credentials, the privacy register and entitlements.

**ADR-65 — Proactive schedules.** `ai_schedule` rows (kind from a closed list: management briefing, stalled opportunities summary, project risk digest, renewal reminders, missing evidence reminders, stock reorder proposal, unusual variance alert, payroll input reminder, meeting brief), agent, cadence, recipients by role, working hours and locale, enabled, deduplication window; runs are background `ai_run`s that read through the same tools, are deduplicated by content hash, respect mute and snooze per person, stop when the evidence changes, and record cost; without a provider the deterministic parts run and the narrative says it was not generated.

## Part G — What was built (implementation record)

### G.1 Migrations

| File | What it adds |
| --- | --- |
| `0128_h28a_intelligence_foundation.sql` | `platform_operator` and its assertions, `platform_audit`, the extended `ai_interaction` ledger (agent, conversation, run, step, model version, cache and reasoning tokens, tool calls, provider request id, latency, retries, estimated and actual cost, price-book row, credits, rate source, budget decision, purpose, error) with a widened feature check, `ai_provider_state` and `ai_model_state` with `app.ai_provider_report` (five failures open a five-minute breaker), the effective-dated `ai_price_book` seeded from the published list prices with their source URLs, `ai_credit_policy`, `ai_kill_switch`, `ai_entitlement` (append-only policy versions), `ai_credit_ledger`, `ai_privacy_register`, `ai_byok_key` (ciphertext columns not granted to `app_user`; `app.ai_byok_ciphertext` reads them for the current organisation only), the operator definer functions (kill switch, provider and model state, price book, entitlement, credit grant, usage, usage rows, organisations) and the `cap.idara` entitlement on every plan. |
| `0129_h28b_conversations_runs_actions.sql` | `ai_conversation` and `ai_message` (private to the person: org AND user), `ai_run` (parent, root, depth, plan, route, credits, cancel, idempotency) and `ai_run_step`, `ai_action` (risk class, preview, record versions, status machine, approval link, idempotency key, expiry), `ai_memory` (scope user or org, live-unique key), `ai_agent` and `ai_agent_version` (immutable snapshots with evaluation evidence), `ai_agent_state`, `ai_saved_output`, `ai_schedule` and `ai_schedule_pref`, the `ai_action` approval subject on `approval` and `approval_rule`, and the platform discovery functions `app.ai_queued_runs` and `app.orgs_with_ai_schedules`. |

Every new table carries `org_id` and RLS except the global registries and the operator tables; no table has a DELETE grant; history tables (`ai_entitlement`, `ai_credit_ledger`, `ai_agent_version`, `ai_message`, `ai_interaction`) have no UPDATE grant either.

### G.2 Platform substrate (`src/platform/ai`)

- `registry.ts` — closed provider and model registries with capability, context, cost class, status and per-model privacy facts, each carrying the source URL and fetch date; task classes with the tier they require and whether they may run lower.
- `adapters/` — one request and response shape (`types.ts`), the disabled adapter, the deterministic test adapter with failure markers, and fetch-only OpenAI (Responses) and Anthropic (Messages) adapters that talk to one host each, map every failure class, and never place a key in a body.
- `pricebook.ts` — effective-dated lookups and exact integer cost estimation, rounded up per category; credits from the effective credit policy; no currency conversion.
- `budget.ts` — the organisation policy, the allowance computed in the database, the switch state and the one ordered `decideBudget`.
- `gateway.ts` — `invokeModel`: size limits, per-organisation availability, routing with recorded reasons, the budget decision, the adapter call with timeout, cancellation and one idempotent retry, response validation, metering of success, failure and denial, and the breaker report. Denials and failures are metered inside their transaction and thrown after it commits.
- `metering.ts` — one `ai_interaction` row per call plus the credit-ledger row and the billing meter (deduplicated by interaction id).
- `byok.ts` — AES-256-GCM encryption under `AI_BYOK_KEK`; fails closed without it.
- `gate.ts` — `idaraGateFor`: flag, organisation policy, switches, provider availability, allowance; `agentsEnabled` (H12) now resolves through it, so the H25, H26 and H27 seams follow the same law.
- `privacy.ts`, `operator.ts`, `prompts/`, `evals/dataset.v1.json`.

### G.3 The Idara module (`src/modules/idara`)

`service.ts` is the door. Inside: conversations and messages, the run engine (plan, context tools, model turns with a strict tool channel, validation, delegation, merge, provenance), the tool registry (37 tools: 24 read, 3 change, 9 restricted with no handler and one draft-class placeholder), actions (preview, confirm, approve, execute, drift, replay), memory, custom agents with versions and the narrowing law, proactive schedules, the queue executor and the evaluation runner.

### G.4 Surfaces

The dock mount in the authenticated shell, the launcher island, the working window, the deep workspace route, the contextual "Ask Idara" menu on customer, deal and document pages, the palette entries, the organisation AI settings, the agent builder, and the operator economics centre at `/platform/ai`.

### G.5 Tests and evidence

_pending: filled from the run results._

### G.6 Honest limits

- No AI provider is configured in production; every provider-dependent capability is unavailable and says so with the exact owner action.
- The OpenAI and Anthropic adapters are contract-tested against recorded shapes with a fake fetch. They have never been run against the live endpoints, so provider failover is proven only at the adapter boundary.
- Provider-reported cost is recorded only when a provider returns it; today neither returns it inline, so the ledger keeps the estimate and says so.
- Voice, transcription, image and spreadsheet understanding are declared seams with no provider and no code path that could call one.
- Charging is not enabled: credits are internal units, the billing adapter records intent only, and no revenue or margin is claimed anywhere.
- Semantic search and embeddings were deliberately not built: retrieval is structured through the module doors, which keeps tenant isolation and citation ground truth exact.
- Inngest is not configured in production, so the background run executor and the schedule sweep only run through the authenticated cron route once its secret is set.
