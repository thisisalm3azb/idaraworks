# H28 — Idara Intelligence: delivery report

Status: **in progress** (the sections marked _pending_ are filled from the
verification and production evidence).

Mandate: `phase2/14-POST-MVP-AMENDMENTS.md` §7 (owner direction, 2026-09-03).
Truth map: `docs/H28-TRUTH-MAP.md` (Parts A–G).
Agent contract: `docs/architecture/ROLE_AWARE_AGENT_ARCHITECTURE.md` §8.

## 1. What the platform is

One ambient assistant, **Idara**, mounted in the authenticated application
shell and never in the navigation sidebar, backed by a governed multi-agent
platform:

- **The dock.** A launcher that appears on every authorised page, remembers
  its position per person per device, can be moved by dragging, by a position
  menu of six logical positions, or by the keyboard, resets from one control,
  keeps clear of the header and the phone navigation, yields when focus lands
  beneath it, shows quiet status (ready, working, waiting for approval, done,
  failed), badges unread Idara notifications, honours reduced motion and never
  opens itself. It opens into a compact quick ask, a movable and resizable
  working window (a bottom sheet on phones) or a full-page workspace; the
  window minimises to a progress chip and reopens with the conversation and
  the run intact.
- **Context without explaining.** The dock reads the current page's record,
  offers to include it, lets people add or remove records, and shows exactly
  which records will be shared. Nothing else leaves the platform.
- **One front door, many specialists.** Idara routes deterministically by
  domain terms in English and Arabic and by the shared records, delegates to
  at most four specialists at depth one, and merges their findings while
  naming who answered and who contributed. People can also address a
  specialist directly or with an `@mention`.
- **Fifteen agents.** The ten from the H11 contract (with `manager` retired
  and resolved to `idara`) plus Customer Success, Tax, Document and Contract,
  Organisation Administration and Idara itself. Every agent carries purpose,
  owner, version, prompt file, knowledge domains, tools, capability class,
  required permissions, approval rule, cost class, sensitivity, default state,
  evaluation version, change history and its replacement when retired.
- **Tools by risk class.** 37 tools: read (through the owning module's door,
  with the person's own permissions and redactions), reversible change, and
  material action; nine restricted tools exist as named refusals with no
  handler at all. Class 3 and 4 tools never execute from a model turn: they
  propose an action with a preview (what, records, old and new values,
  required permission, external communication, estimated cost, reversibility,
  side effects) that a person confirms; the confirmation re-checks identity,
  permission, expiry, status and record versions, refuses drift and replays,
  and executes through the owning service with an idempotency key. Material
  actions additionally ride the existing approval engine with separation of
  duties, then need a second explicit confirmation by the requester.
- **Evidence, not assertion.** Answers separate facts, calculations,
  assumptions and gaps, cite only records the run consulted, list the evidence
  base, and say plainly when the evidence is not enough. A citation to a
  record that was not consulted is dropped and reported.
- **Governed memory, custom agents, schedules.** Memory is written only by an
  explicit action and can be inspected, corrected and revoked; organisation
  agents are built on a platform agent and can only narrow it, are versioned,
  need a passing evaluation to publish and can be rolled back; proactive
  schedules produce quiet, deduplicated briefings in the inbox with mute,
  snooze and frequency per person.
- **Metering and control.** Every model call, including denials and failures,
  writes one usage row with tokens by category, provider request id, latency,
  retries, the estimated cost with its price-book row, credits and the budget
  decision. Organisations see their allowance and recent use; the IdaraWorks
  owner sees economics per organisation, agent and model with drill-down, and
  holds kill switches for the platform, an organisation, an agent, a provider
  and a model.

## 2. What is NOT live

**No AI provider is configured in production.** The platform ships behind
`FEATURE_IDARA_INTELLIGENCE` and every provider-dependent capability fails
closed with the exact owner action. Nothing is simulated: without a provider
Idara still finds the records and shows the evidence, labelled as not
generated.

_pending: the full disabled list and owner actions._

## 3. Verification

### 3.1 Local gates

_pending._

### 3.2 Integration and adversarial evidence

_pending._

### 3.3 CI on the exact commit

_pending._

### 3.4 Production

_pending._

## 4. Owner actions before paid AI can run

_pending._

## 5. Untouched

_pending._
