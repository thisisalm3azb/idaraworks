# IdaraWorks

An AI-configured **Operations Management System** for **GCC-first, project-based industrial and operational SMBs** — the daily control system through which a business plans, assigns, supplies, executes, reports, inspects, approves, measures, bills, and improves its work.

> **Not** an ERP, not a project-management tool, not a no-code builder. The job and its operational event stream are the centre of the system. Fully bilingual **English + Arabic with first-class RTL**.

## What is implemented

The full MVP (slices S0–S11) plus the post-MVP programme is built and deployed:

- **Operations**: jobs with weighted stages and presets, daily/site reports (offline-capable, photo upload), attendance via labour lines, issues, tasks, approvals engine, exception engine + owner digest.
- **Supply & money**: material requests → purchase orders/LPOs → goods receipts; expenses; job costing with labour/margin redaction; quotes → invoices (multi-currency documents, base-currency accounting) → manual payments and receivables; customer updates (secure share links); exports.
- **Onboarding**: a pre-org guided wizard (questionnaire → deterministic template recommendation → configuration proposal → subscription selection → branding → explicit confirm). A catalogue of 8 industry templates installs **structure-only** configuration (never business data).
- **Commercial model**: Free base + individually purchasable add-ons + Medium/High tier bundles + Custom — one entitlement system throughout; real payment collection remains disabled pending the owner's D1 decision.
- **Branding**: org logo/accent applied across the UI and generated documents (LPO/quote/invoice), entitlement-gated.
- **Roles**: owner, admin, manager, foreman (free field seats), procurement, accounts, viewer — each with its own Today dashboard and strict money/labour-cost redaction.

## Architecture

Next.js (App Router) + TypeScript + Supabase/Postgres + Vercel, as a **modular monolith**:

- **Server-side business-data access only** — browser Supabase is auth/session-scoped; data flows through server components and actions.
- **Pooled multi-tenancy**: every tenant-owned table carries `org_id`; application-level tenant context (`src/platform/tenancy`) plus **Postgres RLS as the second wall** (`app_user` is `NOBYPASSRLS`); one schema for every organization.
- **Customer differences are validated configuration**, applied as auditable config revisions — AI/generated setup can never produce code, SQL, DDL, RLS, or migrations.
- Money is integer minor units with currency-aware exponents; authorization and cost/price redaction are enforced at every serialization boundary; mutations flow through a single audited `command()` chokepoint.
- Migrations are sequential and append-only (`supabase/migrations/`, currently `0000`–`0073`).

## Development

```bash
pnpm install
pnpm dev            # http://localhost:3000
pnpm lint           # ESLint incl. boundaries + tenancy tripwires + banned-noun rule
pnpm typecheck
pnpm test           # vitest unit tests
pnpm build
pnpm test:e2e       # Playwright (needs a prior build; starts `pnpm start`)
pnpm format         # prettier (format:check in CI)
```

Requirements: Node 22+, pnpm 10. Environment: see [`.env.example`](./.env.example) — local dev and integration tests require the documented Supabase/database variables. **`pnpm test:integration` runs against a real database — read its config before running.**

## Governance — read before contributing

| Document | Role |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | Operational entry point for contributors/agents — current state + binding rules. |
| [`BUILD_BIBLE.md`](./BUILD_BIBLE.md) | The engineering constitution. Binding on every human and AI contributor. |
| [`phase2/`](./phase2/) | The frozen architecture package (July 2026 baseline). |
| [`phase2/14-POST-MVP-AMENDMENTS.md`](./phase2/14-POST-MVP-AMENDMENTS.md) | **Continuation of the freeze trail** — what was implemented after the freeze, known divergences, current owner directions. |
| `docs/` | Completion reports (`docs/ux/`, `docs/commercial/`, `docs/MVP-READINESS-REPORT.md`), pilot playbook, runbooks, guides. |
| [`PILOT_OWNER_ACTIONS.md`](./PILOT_OWNER_ACTIONS.md) | The owner-operated actions gating a real pilot launch. |

## Status note (snapshot — dated 2026-08-26)

At commit `d9c884c`: lint clean (one known warning), typecheck passing, 650 unit tests passing, production build passing; production deployed at this commit with `/api/health` healthy. Background automation (Inngest) and several provider integrations (email, AI narration, real billing, e-invoicing) were **not yet provisioned** — the app degrades honestly without them. Deployment and readiness statements anywhere in this repository are **snapshots of their date**, not timeless guarantees; production readiness remains conditional on the owner-operated launch actions in `PILOT_OWNER_ACTIONS.md`. Verify current state against the repository and the latest completion reports.
