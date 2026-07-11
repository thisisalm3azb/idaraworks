# IdaraWorks

An AI-configured **Operations Management System** for project-based industrial SMBs — the daily control system through which a business plans, assigns, supplies, executes, reports, inspects, approves, measures, bills, and improves its work.

> **Not** an ERP, not a project-management tool, not a no-code builder. The job and its operational event stream are the centre of the system.

## Governance — read before contributing

| Document | Role |
|---|---|
| [`BUILD_BIBLE.md`](./BUILD_BIBLE.md) | The engineering constitution. Binding on every human and AI contributor. Start with §20 (contributors guide) and §18 (review checklist). |
| [`phase2/13-ARCHITECTURE-FREEZE.md`](./phase2/13-ARCHITECTURE-FREEZE.md) | What is decided and how decisions change (security / scale / pilot evidence only). |
| [`phase2/`](./phase2/) | The frozen architecture package (domain model, engines, permissions, security checklist). |
| [`impl/S0-EXECUTION-CHECKLIST.md`](./impl/S0-EXECUTION-CHECKLIST.md) | The approved S0 build plan. |

## Status

**Slice S0 (bedrock) — Phase A complete:** tooling, CI, boundary enforcement, design-system foundation. No database, auth, or business logic yet (Phases B–I).

## Development

```bash
pnpm install
pnpm dev            # http://localhost:3000
pnpm lint           # ESLint incl. boundaries + tenancy tripwires + banned-noun rule
pnpm typecheck
pnpm test           # vitest unit tests
pnpm build
pnpm test:e2e       # Playwright smoke (needs a prior build; starts `pnpm start`)
pnpm format
```

Requirements: Node 22+, pnpm 10 (`npm i -g pnpm`). Environment variables: see [`.env.example`](./.env.example) — none are required for Phase A.

## Structure

```
src/platform/   L1 substrate: registries, logger, http policy, ui design system (tenancy/auth/… arrive in S0 B–G)
src/modules/    capability modules (empty until S1+) — service.ts is each module's only public surface
src/lib/        pure utilities (no IO, no business logic)
src/app/        Next.js routes — thin
src/workers/    task-queue entry points (Phase G)
tooling/        custom ESLint rules, scripts
tests/          unit / integration / e2e
```

Import boundaries are enforced by ESLint (`boundaries/element-types`) — a violation fails the build, not the reviewer's patience.
