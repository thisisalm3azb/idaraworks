# H27 — CRM and Revenue Growth Studio: delivery report

Status: **built, tested on the isolated TEST project, deployment in progress**
(the sections marked _pending_ are filled from the production evidence).

Mandate: `phase2/14-POST-MVP-AMENDMENTS.md` §6 (owner direction, 2026-09-02).
Truth map: `docs/H27-TRUTH-MAP.md` (Parts A–G).

## 1. What is live once the flag is on

One studio under `/o/<org>/revenue`, behind `FEATURE_REVENUE_STUDIO` (exact
`"1"`) and the `cap.revenue_studio` module (a blueprint can switch it off):

- **Overview** — counts and totals across the full result, funnel, pipeline by
  stage and weighted forecast by month (lazy SVG), the person's commercial
  queue, stalled deals, targets, campaigns, and a command centre (Ctrl+K)
  with database-side search over deals, leads and customers.
- **Pipeline** — several pipelines, one default; drag-and-drop with a
  keyboard/select path; every move goes through one governed command
  (requirements checked, reason and mover recorded, history preserved, stale
  row versions refused); bulk moves reviewed first; column aggregates over
  the full filtered result; database paging.
- **Leads & enquiries** — capture with consent at capture; outside sources
  (web form, email, messaging, API) land in quarantine until a person trusts
  them; duplicates surfaced; qualification with evidence; disqualify with a
  reason; duplicate-safe, idempotent conversion.
- **Deal room** — stakeholders and coverage, product lines that own the deal
  value (minor-unit arithmetic, per-line tax as agreed), competitors, risks,
  commercial context, discount requests decided by a person through the
  shared approvals engine, stage and forecast history, a lazy React Flow
  canvas, and the fail-closed assistant.
- **Customer 360** — ownership, territory, tags, segment; contacts with
  buying roles and per-channel consent; documents, obligations, renewals,
  issues, signals; a health score that shows its evidence and admits unknowns;
  the timeline; a reviewed merge (preview → resolve → reason → one transaction,
  immutable evidence, source pointer, no record loss).
- **Forecast** — deterministic, every figure names its model; weighted values
  are expectations, never promised revenue; snapshots with accuracy;
  scenarios as overlays until an owner applies them through the governed
  commands.
- **Campaigns** — attribution by named model (first / last / linear,
  correlation only); touches; marketing messages only from an explicit,
  consent-checked send that fails closed without a provider.
- **Targets & territories** — dated targets with a stated basis; territory
  rules assign only unassigned customers; no activity surveillance.
- **Customer success** — every active customer scored with the shared model;
  band counts over the full set; renewals due.
- **Automations** — owner, trigger, conditions, actions, enabled state,
  dry run, run history; idempotent per subject and occurrence; bounded to
  reviewed work (never a signature, send, posting or merge); a daily sweep.
- **Reports** — funnel, win/loss, activity with a basis sentence; CSV exports
  through the governed export route; a branded PDF through the platform
  renderer.
- **Imports** — contacts, leads and opportunities with a read-only dry-run
  preview (duplicates in the batch and against records, unresolved
  customers), reviewer skip, idempotent apply.
- **Pipelines & stages** — requirements, exit criteria, default probability,
  max age per stage.

Everything is EN/AR with RTL, works at 375 px, and pages from the database.

## 2. Honestly disabled

- Email, calendar and messaging providers: declared, off until an owner
  provisions credentials (OA-4). Marketing sends fail closed.
- Inbound lead adapters (mailbox, messaging, API keys): declared, off.
- The assistant: off until a model provider is configured for the
  organisation; when on it only proposes, with validated evidence.

## 3. Evidence

### 3.1 Local gates (commit `58fa0f0` on `verify/h27`)

Prettier, TypeScript (strict), ESLint (module boundaries), unit suite 95
files / 1,466 tests (incl. `crm-pure`, flags, registries, export catalogue,
i18n parity and the domain-noun law), production build with every
`/revenue` route and the report API registered.

### 3.2 Integration on the TEST project (`zwnnqaryouevnzuwtyaj`)

| Suite | Covers | Result |
| --- | --- | --- |
| `h27a-foundation` | pipelines, governed moves, board aggregates, deal room, activities | 6/6 |
| `h27b-capture-forecast` | quarantine, duplicates, idempotent conversion, consent gate, attribution, targets, forecast/snapshot/overlay | 6/6 |
| `h27c-merge-automation-ai` | merge preview/apply/evidence/re-merge refusal, automation dry vs live idempotency, assistant fails closed + evidence validation | 3/3 |
| `h27d-imports` | contacts/leads/opportunities imports, dry-run preview, skip, idempotent apply | 3/3 |
| `h27e-reports-success-sweep` | funnel/win-loss/activity aggregates and redaction, success overview, platform sweep discovery and idempotency | 2/2 |

Every suite creates marked organisations and wipes them (zero residue).

### 3.3 Headless UI walk (TEST fixture: 1,250 leads, 1,150 deals)

`h27-ui-shots.ts` against `dev-revenue-preview.mjs`, 46 captures in
`.h27-shots/` (not committed): token-hash sign-in; command centre search
opens a deal; pipeline total 1,062 open deals with column aggregates across
the full result and page 2 served from the database; a governed move through
the card's own select ("Move to Contacted … Moved") with the reason captured;
leads total past 1,000 (1,255 after the walk's own capture), page 3, the
quarantine queue, a quarantined lead trusted, a capture redirecting with
"Lead captured"; every deal room tab incl. the lazy React Flow canvas mounted
and the assistant reporting itself off; Customer 360 and a merge preview
listing the records that would move; forecast with the model statement and
disclaimer; campaigns, targets, success (band filter), automations dry run
redirecting with the run summary, reports; the branded PDF (200,
application/pdf, 65,658 bytes, 2 pages) in English and Arabic; Arabic pages
`dir=rtl lang=ar`; 375 px captures of hub, pipeline, leads, deal, products,
customer, success and forecast. The only residual note is a dev-server
stale-chunk message during hot reloads; the mobile board's containment was
confirmed directly in the browser at 375 px (document width 375, the board
scrolling inside its own container) and is re-proven by the production walk.

### 3.4 CI on the exact commit

_pending_

### 3.5 Production

_pending_ — pre-flight, baseline, migrations 0120–0127, health, smoke with
the flag off, flag on, smoke with the flag on, UI walk, residue, health.

## 4. Untouched, as instructed

No historical accounting records converted; H24 transition ambiguities
unresolved; PO-002 untouched; the deferred H22 stock-posting problem not
mixed in; H28 not started; production business data unchanged (the smoke
and walk fixtures self-destruct and residue is proven zero).

## 5. Limitations

- Health uses one shared weighted model; a single churn record lowers the
  score but does not by itself force the "at risk" band.
- Attribution is correlation, never causal impact.
- No exchange rates: a deal keeps its own currency and nothing is converted.
- Team-scoped targets are stored but the studio's target form offers org,
  person and territory scopes.
