# H25 — Truth map and architecture decisions (Management Studio)

Audit date 2026-09-02, on production commit `ea270e6` (app `51c2f79`),
migrations 0106, all H22/H23/H24 flags live. Companion:
`docs/H25-EVIDENCE-LOG.md` (library and method research with sources).

## 1. What already exists (canonical — the Studio extends, never copies)

| Concept | Canonical record | Owner |
| --- | --- | --- |
| Project / work | `job` (status_category, priority, owner, start/due/completed dates, origin, customer link) | `src/modules/jobs/service.ts`, `lifecycle.ts` |
| Phase | `job_stage` (snapshot key/name/weight/sort + `phase_semantic`) | `stages.ts`; progress derived in `progress.ts`, never stored |
| Task | `task` (7-state lifecycle, assignee employee, start/due dates, estimated/actual minutes, parent depth ≤2, blocked_reason, requires_approval) | `tasks.ts` (explicit transition graph) |
| Dependency | `task_dependency` (finish_to_start + blocks, soft removal, live-unique per pair; cycle BFS ≤50 depth in service; readiness recompute) | `dependencies.ts` |
| Working time | `org.working_week` jsonb + `org_holiday_calendar` via `src/platform/calendar/calendar.ts` (isWorkingDay, workingDaysBetween) | platform |
| Weekly plan | `week_plan` + `week_plan_job` (issued document; links JOBS only) | `documents/week-plan.ts` |
| Approvals | `approval` + `approval_rule`; four-place subject registration (registry, SUBJECTS map, two DB CHECKs) | `approvals/service.ts` |
| Issues | `issue` (severity, is_blocker flag, nullable job link) | `issues/service.ts` |
| People/capacity inputs | `employee`, `team`, `attendance`, leave (types/requests/ledger), payroll costs | H23 modules |
| Money | H24 ledger + budgets + invoices/payments/expenses | finance door |
| CRM | `customer`, `lead`, `opportunity`, pipeline stages | `crm`, `masters` |
| Stock | H22 warehouses/items/movements/assets | `inventory`, `assets` |
| Comments/files/audit | `comment`, `file` + ATTACHABLE registry, `audit_log`, `activity` | platform |

**Missing entirely (H25 adds):** milestones, deliverables, baselines,
lead/lag, SS/FF/SF dependency kinds, duration-in-working-days scheduling,
critical path/float, portfolios/programs/objectives/KRs/initiatives,
scenarios, risks/assumptions/decisions/changes registers as first-class
records, KPI catalogue, canvas/nodes/edges/views, capacity allocations,
resource requests, planning templates. Gantt/board/3D surfaces: none.

## 2. Production baseline (read-only, 2026-09-02, `h25-baseline.ts`)

39 orgs · 93 jobs (59 done / 29 active / 4 on hold / 1 draft) · 497 stages ·
**0 tasks · 0 task dependencies · 0 week plans** · 13 approvals · 19 issues ·
37 employees · 0 teams · 51 customers · 0 leads/opportunities · 46 quotes ·
78 invoices · 0 budgets · **0 journal entries (H24 books not installed)** ·
48 holiday-calendar rows.

**Consequence:** there is NO historical planning data to convert. The task
engine shipped in H21 but production adoption is zero, so H25 creates the
first plans against live jobs/stages. No transition ambiguity exists for
planning data. The standing exceptions remain untouched and are SURFACED,
never repaired: PO-002 (two receipts, no stock movements, no accounting
entries) and the unconverted accounting history (empty production ledger).

## 3. Pre-existing drifts found by this audit

1. **`journal_entry` approval rules are impossible** — `APPROVABLE_TYPES`
   and `CreateRuleInput` accept it, but the DB CHECKs
   (`approval_subject_type_check`, `approval_rule_subject_type_check`) were
   last widened in 0095 and stop at `pay_run`, so creating the rule throws a
   raw CHECK violation and the H24 segregation-of-duties gate
   (`assertJournalApprovedIn`) is unreachable. **Fixed in H25's first
   migration** (additive CHECK widening + regression test).
2. `expense` sits in `APPROVABLE_TYPES` but not the SUBJECTS dispatch map —
   an auto-approving expense rule would decide without advancing the
   subject. Documented; not H25 scope (behavioral decision for the owner).
3. **`week.ts` derived view is stale against H21 task statuses** — filters
   `('pending','in_progress')`, so `ready`/`blocked`/`awaiting_approval`
   tasks vanish from /week, and the partial index carries the same stale
   predicate. **Fixed in H25** (shared OPEN_TASK_STATUSES + index rebuild).

## 4. Architecture decisions

**ADR-1 — Two layers, one truth.** The EXECUTION layer stays canonical
(`job`, `task`, `task_dependency`, stages, people, money). The STUDIO layer
adds a typed planning graph that either (a) LINKS a canonical record
(`record_type` + `record_id` with composite-FK safety) or (b) holds a
PLANNING-ONLY element (objective, risk, decision, draft task…) until it is
explicitly converted into a real record. Status, dates, assignments, cost
and progress of linked records are **read through the owning module and
written through its service functions** — never copied into studio tables.

**ADR-2 — One graph resolution, many projections.** A single
`resolvePlanGraph(ctx, planId, {scenarioId?, baselineId?})` produces typed
nodes+edges with *effective fields* (canonical record fields for linked
nodes, node fields for drafts, scenario overlay on top). Every view —
canvas, board, table, Gantt, timeline, calendar, network, critical path,
workload, heatmap, risk matrix, roadmap, 3D — renders this one resolution,
and every edit calls the same mutation service, which routes linked-record
writes through the owning module (permissions + audit intact) and
draft/scenario writes into studio tables.

**ADR-3 — Collaboration is server-authoritative; CRDT rejected.** Yjs's own
ecosystem documents authorization as out of scope and client updates as
spoofable; the mandate requires that a disconnected client can never sync
an unauthorized edit. Therefore: all writes are server actions through the
permission matrix; concurrency is optimistic row-versioning
(`row_version`+ conflict retry); presence/cursors/selection and
graph-changed invalidation ride **Supabase Realtime private channels**
(RLS-authorized via `realtime.messages` policies; per-plan topic
`studio:<orgId>:<planId>`), which our stack already operates. Version
history = named checkpoints (graph snapshots) + the audit trail.

**ADR-4 — Libraries** (registry-verified 2026-09-02): `@xyflow/react`
12.11.6 (MIT, peer react ≥17 — React 19 OK) for the canvas engine —
controlled state, custom nodes/edges, viewport culling;
`three` 0.185.1 (MIT) for the 3D world — **dynamically imported on the 3D
route only**, WebGPURenderer with automatic WebGL2 fallback, plus a full 2D
equivalent for unsupported devices; `@dagrejs/dagre` 3.1.1 (MIT) for
auto-layout of derived views. No other runtime dependencies. Yjs not
adopted (ADR-3).

**ADR-5 — Scheduling engine is pure, deterministic TypeScript**
(`src/modules/studio/engine/`): forward/backward pass over WORKING days via
the existing platform calendar; FS/SS/FF/SF with lead/lag; constraints
(start-no-earlier, finish-no-later, deadline); total float = LS−ES, free
float; multiple zero-float chains reported; schedule-health checks anchored
to DCMA 14-point thresholds (missing logic, hard constraints, high float,
negative float). Inputs are plain data; the engine never touches the DB, so
it is exhaustively unit-testable and can run in a worker.

**ADR-6 — Dependency model extended canonically.** `task_dependency.kind`
widens (additively, values preserved) to
`finish_to_start | start_to_start | finish_to_finish | start_to_finish |
blocks`, plus `lag_days integer` (working days, may be negative for leads).
Draft-to-draft and draft-to-linked dependencies live on `plan_edge` until
conversion; on conversion they become real `task_dependency` rows through
the existing service (cycle detection intact).

**ADR-7 — Scenarios are overlays, never copies.** `scenario` (per plan,
private/shared, states draft→under_review→approved→applied/discarded) +
`scenario_change` rows (`target_kind`, `target_id`, `field`, `old`/`new`
jsonb). Resolution overlays effective fields; NOTHING touches canonical
records until an authorized APPLY replays the changes through the owning
services inside one audited command, with a decision record. Monte Carlo
(if inputs exist): three-point estimates explicitly entered, seeded
deterministic RNG, stored seed + sample count + P50/P80/P90; refuses with
"insufficient estimates" rather than inventing distributions.

**ADR-8 — Permissions.** New actions (`studio.view`, `studio.manage`,
`studio.schedule`, `scenario.manage`, `scenario.apply`, `kpi.manage`,
`register.manage`) mapped onto existing archetypes (owner/admin/manager
manage+apply; foreman/procurement/accounts view where relevant; viewer
read-only). A linked node NEVER widens access: each node's detail payload
is filtered by the TARGET record's own view action and the cost/price
walls; a viewer without `invoices.view` sees an invoice node's existence
and title, not its amounts (summary-level disclosure is governed by the
linking plan's own permission, amounts by the record's). Studio surfaces
sit behind `FEATURE_MANAGEMENT_STUDIO === "1"` (strict; near-miss
spellings off, unit-pinned) AND a `cap.studio` entitlement on all plans.

**ADR-9 — Truthfulness (constitutional, inherited).** No invented numbers:
KPIs and simulations show "insufficient data" with the reason; scheduling
over tasks without dates shows unscheduled-work warnings; PO-002 and the
empty production ledger surface as data-quality notices in any view that
would otherwise mislead. Visualizations never backfill history.

**ADR-10 — Performance.** Canvas: viewport culling, capped initial payload
with server paging, memoized node renderers. Graph reads: one resolution
query set, paged, bounded. 3D: code-split, LOD (instanced meshes beyond
~200 structures), reduced-motion honored, context-loss recovery. Engine:
pure functions, incremental recompute per plan, worker-ready. Budgets in
H25P tests: 60fps target interaction at 1k visible nodes, engine <150ms
for 5k tasks/10k edges on CI hardware, 3D route JS ≤ heavyweight budget
loaded only on entry.

## 5. Slice order

B graph schema+services → C canvas → D scheduling engine → E synchronized
views → F 3D → G scenarios → H resources/capacity → I portfolio/strategy →
J KPIs → K registers → L collaboration → M AI → N templates → O/P polish +
performance/a11y → Q permissions hardening → R verification/deploy. Each
slice lands with integration tests green before the next begins.

## 6. Platform facts that shaped the decisions (agent audit, 2026-09-02)

- **Realtime is unused today** and Realtime RLS evaluates as the JWT user —
  our `app.current_org_id()`/`app.cost_priv` GUCs (set per-connection by
  `withCtx` on the server pool) are NOT present there. ADR-3 therefore adds
  two hard rules: (a) the `realtime.messages` policies for studio topics
  authorize by **JWT claim + membership lookup** (`auth.uid()` must be an
  active member of the org encoded in the topic), and (b) **broadcasts and
  presence never carry business data** — only presence coordinates
  (user, cursor, selected node ids) and "graph changed, refetch" pings with
  row versions. Every piece of record data still flows through the one
  server enforcement point.
- **Enforcement pattern**: 389 `assertCan()` sites in services + bare
  `can()` in RSC bodies + nav gating + RLS backstop. There is no RoleGate
  component; H25 follows the house pattern exactly.
- **Cost/capacity inputs exist**: `employee_terms.hourly_cost_minor` +
  `ot_rate` (cost-walled, frozen-at-use precedent via
  `report_labour_cost`), `work_pattern`/`shift`/`schedule_assignment`,
  leave ledger + GiST-excluded `leave_request`, `attendance`. **No skills
  tables exist anywhere** — H25H introduces `skill` + `employee_skill` +
  node-level requirements as the first competency model.
- **The A1 agents layer is complete but inert**: 10 agents, 7 read-only
  tools bound to authz actions, strict output contract (separate facts/
  calculations/assumptions/suggestions, fabricated-citation rejection,
  forced approval-required), NO model-directed tool channel — but the
  provider is `DisabledAgentProvider`, zero tool handlers are registered,
  no route exists, and `feat.ai_agents` is deliberately unregistered.
- Notifications: 5 kinds, 3 emit sites, in-app only. Files: images-only
  uploads, two buckets, class-based access. i18n: cookie locale, ICU with
  Latin numerals under `ar`, one root `dir` attribute + logical properties.

**ADR-11 — Management AI in two honest tiers.** Tier 1 (ships fully in
H25M): **deterministic planning analysis** computed by the scheduling and
capacity engines — critical-path explanations, missing/contradictory
dependency and date detection, overload attribution, scenario difference
summaries, recovery-option enumeration (crash/fast-track/re-sequence
candidates from float and calendars). Labeled "computed analysis", never
"AI". Tier 2 (LLM drafting — goal→draft plan, decomposition, meeting
notes→actions): implemented ON the existing A1 seam (registered studio
read tools + handlers + contract validation + audit), with proposals
landing as DRAFT scenario changes that a person must apply. Tier 2
activates only when the owner provisions a model provider key —
`feat.ai_agents` registration + provider config are an **external-authority
blocker documented for the owner**, and the UI says "AI drafting is not
enabled for this workspace" rather than pretending. Nothing anywhere
auto-commits: both tiers can only create draft/scenario material.

**ADR-12 — Reuse before invention.** Comments (`comment` table), files
(`file` + ATTACHABLE), audit (`command()`/`audit_log`), references
(`allocateReference`), notifications (additive `studio_mention` kind),
approvals (new subjects `scenario_apply`, and the 0107 CHECK repair),
events registry untouched in v1 (studio live-refresh is Realtime, not the
outbox). The `week_plan` document stays; the Studio links to it rather
than replacing it.
