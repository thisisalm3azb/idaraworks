<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# IdaraWorks — agent instructions

You are working on **IdaraWorks**, an AI-configured Operations Management System for project-based industrial SMBs. This codebase has a binding engineering constitution.

## Non-negotiable, before any change

1. **Read [`BUILD_BIBLE.md`](./BUILD_BIBLE.md)** — at minimum §2 (principles), §3 (architecture rules), §18 (review checklist), §19 (anti-patterns). Every rule there is enforceable law, not guidance.
2. **The architecture is frozen** ([`phase2/13-ARCHITECTURE-FREEZE.md`](./phase2/13-ARCHITECTURE-FREEZE.md)). Do not redesign. Changes to frozen decisions require: a verified security issue, a proven scalability/reliability issue, or real pilot evidence — recorded in the freeze amendment log with owner approval.
3. **Specs win.** Implementation follows `phase2/01`–`10` and `impl/S0-EXECUTION-CHECKLIST.md`. If code and spec disagree, flag the divergence — never resolve it silently.

## Hard rules (subset — the Bible has the full set)

- The `job` and its operational event stream are the centre; never reorganise toward ERP/departments.
- No feature bypasses tenant isolation: all data access through `src/platform/tenancy` (ESLint-enforced); every tenant table gets RLS in the same migration.
- Money: `bigint` minor units, currency-aware exponents (KWD/BHD/OMR = 3), VAT recorded never assumed; money paths need golden-file tests.
- Derived values are computed by exactly one owner; never hand-set.
- Closed vocabularies live only in `src/platform/registries.ts`.
- No hardcoded domain nouns in UI (lint-enforced) — terminology resolver only.
- RTL-first: logical CSS properties only; 44px touch targets on field flows.
- Complete the PR checklist (`.github/PULL_REQUEST_TEMPLATE.md`) honestly; label AI-authored PRs `ai-authored`.

## Current state

Slice **S0 Phase A** done (tooling/CI/design system). Database, auth, tenancy, storage, queue arrive in Phases B–G per the S0 checklist — do not start a later phase without owner approval.
