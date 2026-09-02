# H25 — IdaraWorks Management Studio: completion report

Status: **code complete on `verify/h25`; production deployment steps recorded below with their evidence** (sections marked PENDING are filled as each step lands).

## 1. What was built (one living model, many perspectives)

- **Planning graph (H25B)**: `studio_plan`, `studio_node` (~40 semantic node types, validated data schemas), `studio_edge` (11 edge types; dependency edges carry FS/SS/FF/SF + lag), `studio_view`, `studio_scenario`, `studio_scenario_change`, `studio_baseline`, `studio_version`. A node LINKS a canonical record (task, job, employee, customer, …); it never copies it. Linked task fields route through the jobs door; conversion and linking go through `app.link_studio_node` (one direction only).
- **Canvas (H25C)**: React Flow 12 infinite canvas with semantic shapes, drag (positions never bump the business row version), connect-to-depend, palette of 22 shapes, minimap, fit/zoom, inspector with dirty-field saves and row-version conflicts, link-an-existing-record, duplicate, comments on elements, command palette (Ctrl/Cmd+K: find any element, run commands), filters that narrow every projection without a second truth, focus mode, saved views (private/shared/retire), undo as replayed inverse actions, presence rings from peers.
- **Scheduling engine (H25D)**: pure deterministic CPM over the org calendar (working days, holidays): forward/backward pass, ES/EF/LS/LF, total and free float, driving-link critical paths, constraints (start-no-earlier, finish-no-later, deadline), FS/SS/FF/SF with lead/lag, milestones, DCMA health (missing logic, hard constraints, high float, negative float), refusals (cycle, no anchor, empty calendar). Baselines with variance in working days. Connector editing re-makes the real dependency.
- **Synchronized views (H25E)**: canvas, board (status moves commit through the task lifecycle), Gantt (bar drag moves the real start, calendar shading from the org calendar), network/critical path (dagre), roadmap, calendar, workload/capacity, risk matrix, strategy map, indicators, table, 3D. Every view is a projection of the same resolution and schedule.
- **3D (H25F)**: three 0.185 with `WebGPURenderer` (WebGL 2 fallback), dynamically imported only when the 3D view opens; plan city, time tunnel, capacity world; hover names, click selects; 2D roadmap fallback when the device cannot render.
- **Scenario laboratory (H25G)**: scenarios are overlays (`studio_scenario_change`) applied generically over every planning field; compare shows from → to with drift detection and schedule delta; assumptions and decision record; Monte Carlo with stored seed/sample count (P50/P80/P90, confidence in the plan date, criticality index) that refuses without three-point estimates; submit through the approval engine as `scenario_apply`; approval only makes a scenario applicable; apply (owner/admin) replays through the owning services and refuses on drift.
- **Resources and capacity (H25H)**: canonical `skill`, `employee_skill`, `task_allocation`; capacity report per person per ISO week against calendar capacity (assignee counts implicitly; unassigned work visible; people withheld for roles without `employees.view`); leveling proposes a draft scenario, never moves work. No pay or cost-rate data.
- **Portfolio and strategy (H25I)**: portfolio home with a transparent 3-component score and its basis per plan; strategy map of objectives, key results and initiatives.
- **KPI catalogue (H25J)**: 13 governed indicators, each with a stated basis, computed from canonical data; "insufficient data" with the reason, never zero as if measured.
- **Registers (H25K)**: risks, issues, assumptions, decisions, changes, actions, lessons, constraints, opportunities across all plans, paged, with derived risk scores and links back to the plan.
- **Real-time collaboration (H25L)**: private Supabase Realtime channels per plan authorised by RLS on `realtime.messages` through a SECURITY DEFINER membership predicate; presence (who, which view, which selection) and a "changed" nudge; every edit remains a server action, so a disconnected client cannot synchronise anything it was not allowed to do.
- **Controlled assistance (H25M)**: deterministic review findings with explicit next steps; the A1 narrative seam fails closed ("assistant not provisioned") until the owner provisions a provider.
- **Living templates (H25N)**: three built-in starting points instantiate as anchored draft networks through the normal doors; any plan can be saved as an organisation template (bounded).
- **Permissions (H25Q)**: lanes `studio.view/manage/schedule`, `scenario.manage/apply`, `kpi.manage`, `register.manage`, transcribed for every archetype; a linked node never widens access to its record.

## 2. Architecture decisions

ADR-1..12 (`docs/H25-TRUTH-MAP.md`) plus ADR-13..18 added while building: Realtime definer predicate; leveling proposes; allocations/skills canonical; templates anchor; presentation state never a second truth; assistance in two tiers, fail closed.

## 3. Migrations (all additive; audited)

| File | What | Notes |
| --- | --- | --- |
| 0107 | planning graph tables, entitlement, task scheduling columns, widened CHECKs (`approval.subject_type`, `approval_rule.subject_type`, `task_dependency.kind`), `task_org_due_idx` rebuilt | pre-flight verifies every live value fits the widened lists (PRE-FLIGHT CLEAR on production, 2026-09-02) |
| 0108 | `app.link_studio_node` definer | the only UPDATE is inside the function body |
| 0109 | draft-node estimates, constraints, deadline | |
| 0110 | `skill`, `employee_skill`, `task_allocation` | RLS, column-scoped grants, no DELETE |
| 0111 | Realtime policies (first form) | kept as applied on the test project |
| 0112 | `app.studio_channel_allowed` definer + policies recreated | `drop policy if exists` is the only drop |
| 0113 | `studio_view.removed_at` | |

## 4. Tests

- Unit: CPM (17 hand-computed cases), Monte Carlo (7), leveling (3), scale (5,000 activities / ~10,000 dependencies in under 5 s, deterministic), permissions (2), registries/flags/workspace laws; full suite **1435 passing** at the time of writing.
- Integration (test project `zwnnqaryouevnzuwtyaj`, migrations 0107–0113 applied): h25b-graph (5), h25d-schedule (4), h25d-edge (4), h25g-scenarios (7), h25h-capacity (5), h25l-realtime-policies (4), h25n-governance (7), bleed harness (2, with seeders for all 27 H25 tables).
- CI on the exact commit: **green** at `04c1093` (https://github.com/thisisalm3azb/idaraworks/actions/runs/33607750971): quality (lint, unit, build) and integration (74 suites on CI's own Supabase stack, including all H25 suites and the bleed harness). Two earlier runs failed and were fixed: the bare CI stack has no `realtime.messages` (policies now guarded) and denies `authenticated` USAGE on the realtime schema (predicate tests pass the topic explicitly).

## 5. Evidence

- Browser (test project, dev preview): canvas render, drag persisted (`studio.node.move` audit), inspector save routed to the real task (`task.update`), board move through the task lifecycle (`task.status` → in_progress), Gantt drag moved the real start date and re-computed the critical chain, all five first projections agreed; mobile 375 px chrome and canvas; screenshots captured in-session. Later projections (roadmap, calendar, workload, risk matrix, strategy, indicators, 3D, scenario panel, review panel) were verified by type-check, lint, the integration suites above and the production build; the Browser pane was hidden for the rest of the session, so their interactive verification is PENDING (production smoke plus a browser pass once the pane is available).
- Headless walk (Playwright against the dev preview on the test project, signing in through the app's token-hash route): screenshots of every projection (canvas, board, gantt, network, roadmap, calendar, workload, risk matrix, 3D plan city on WebGL 2, strategy, indicators, table), the scenarios and review aside tabs, the command palette finding an element, the registers and portfolio pages, Arabic, and the 375 px mobile viewport for canvas/board/workload/indicators; each PNG was inspected. All projections agreed on dates, the critical chain and Rigging's one day of float.
- Found by that walk and fixed: the Content Security Policy named only the https Supabase origin, so the Realtime websocket (wss://…supabase.co) was refused and presence never connected; `connect-src` now includes the ws(s) form of the same host (next.config.ts). Also two non-existent copy keys on the plans page.
- Code-split proof: three.js lives in one 799 KB chunk that the plan page's client manifest (12 chunks) does not reference; the 3D module loads only when the 3D view opens.
- Truthfulness: the trailing-milestone finish bug, the scenario overlay gap (only start/due/duration were overlaid) and the stale-form overwrite were each found by a test or a browser check and fixed with a regression test.

## 6. Deployment (H25R) — PENDING until each step lands

1. CI green on `verify/h25` at commit `04c1093` (run 33607750971).
2. Pre-flight on production: **CLEAR** (2026-09-02; baseline orgs 39, tasks 0, deps 0, employees 37, approvals 13)
   - Production health before deploy: HEALTHY (106 migrations applied, 7 pending = 0107–0113, 197 public tables, 0 without RLS, no unexpected DELETE grants, 0 new orphan identities/sessions); `/api/health` reports commit `ea270e6` (H24 live).
   - `migrate-prod.ts --dry-run` lists exactly 0107–0113 as pending; `main` (ea270e6) fast-forwards to `verify/h25` (15 commits), so the deployed hash will equal the tested hash.
3. Migrations 0107–0113 applied to production via `migrate-prod.ts` on 2026-09-02 after a second PRE-FLIGHT CLEAR; `prod-health.ts` afterwards: HEALTHY, 113 applied, 0 pending, 0 tables without RLS, no unexpected DELETE grants, 0 new orphan identities/sessions.
4. `main` fast-forwarded to `04c1093` and pushed (Vercel builds main); deployed hash check: PENDING
5. `FEATURE_MANAGEMENT_STUDIO` absent → `/o/<org>/studio` not found (smoke `--surfaces` off): PENDING
6. Marked smoke on production (`h25-prod-smoke.ts`): PENDING
7. `FEATURE_MANAGEMENT_STUDIO=1` set exactly, redeploy, smoke `--surfaces=on`: PENDING
8. Fixtures removed, residue 0, historical counts intact: PENDING

## 7. Not built, deliberately or by blocker

- Assistant narrative: the platform provider is disabled (external-authority blocker: the owner must provision a model provider); the seam is wired and fails closed.
- 3D "strategy landscape" and "process world": not built; city, tunnel and capacity are.
- Cost map and geo map views: no canonical geo data; cost amounts appear on elements but no dedicated map view.
- Alignment/distribution tools and connector waypoint routing: not built.
- Historical accounting conversion remains undecided (H24 ruling); PO-002 untouched.

## 8. Production runbook (executed in this order; evidence recorded in §6)

1. CI green on `verify/h25` at the candidate hash (GitHub Actions run URL recorded).
2. `npx tsx tooling/scripts/h25-deploy-preflight.ts` (read-only) must print PRE-FLIGHT CLEAR.
3. `npx tsx tooling/scripts/prod-health.ts` (read-only) must print HEALTHY.
4. `npx tsx tooling/scripts/migrate-prod.ts --confirm=apply-migrations-to-anhgeeutrwftsvuzfinf` applies exactly 0107–0113 (additive; the old code keeps working because nothing existing changes shape).
5. `git checkout main && git merge --ff-only verify/h25 && git push origin main`; Vercel builds main; `/api/health` must report the merged hash.
6. With `FEATURE_MANAGEMENT_STUDIO` absent: `npx tsx tooling/scripts/h25-prod-smoke.ts --confirm=<phrase>` (surfaces off) must pass all checks and leave residue 0.
7. `vercel env add FEATURE_MANAGEMENT_STUDIO production --value 1 --yes` then a production redeploy; `vercel env ls production` shows the variable.
8. `h25-prod-smoke.ts --confirm=<phrase> --surfaces=on`: studio visible, plan workspace renders, three.js absent from the first load; residue 0; historical counts intact.
9. `prod-health.ts` again: HEALTHY, 113 migrations applied, 0 pending.
10. Report finalised; handover memory updated.
