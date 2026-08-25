<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# IdaraWorks — agent instructions

You are working on **IdaraWorks**, an AI-configured Operations Management System for GCC project-based industrial SMBs. This codebase has a binding engineering constitution — and it is a **mature, deployed application**, not a scaffold.

## Current state (updated 2026-08-26 — do not trust older milestone docs for status)

- **All MVP slices S0–S11 are implemented, plus the post-MVP programme**: 8-template catalogue, Free/Medium/High/Custom add-on commercial model, pre-org onboarding wizard, org branding, dashboard/navigation redesign, and two founder-fix rounds. The app is deployed to Vercel production and runs against the hosted Supabase database.
- **Authoritative current-state documents**: [`phase2/14-POST-MVP-AMENDMENTS.md`](./phase2/14-POST-MVP-AMENDMENTS.md) (what changed after the architecture freeze + owner directions), the latest completion reports (`docs/ux/FOUNDER_FIX_ROUND_2_REPORT.md`, `docs/ux/FOUNDER_UX_COMPLETION_REPORT.md`, `docs/POST_MVP_TEMPLATE_ADDON_COMPLETION.md`, `docs/commercial/`), and launch status in `PILOT_OWNER_ACTIONS.md`.
- **Old milestone/progress reports are historical snapshots** — accurate when written, not necessarily now. Before planning any work, inspect the current repository and the *latest* completion reports; do not assume from documents alone.
- Migrations run `0000`–`0073` (append-only, sequential); **the next migration number is `0074`**. Never edit an applied migration.
- Production is live with real organizations. **Never mutate production or the protected organizations casually** — destructive or production-affecting actions require explicit owner approval, dry-runs first, and the protected-org lists in the progress docs are binding.

## Non-negotiable, before any change

1. **Read [`BUILD_BIBLE.md`](./BUILD_BIBLE.md)** — at minimum §2 (principles), §3 (architecture rules), §18 (review checklist), §19 (anti-patterns). Every rule there is enforceable law, not guidance.
2. **The architecture freeze still applies** ([`phase2/13-ARCHITECTURE-FREEZE.md`](./phase2/13-ARCHITECTURE-FREEZE.md), continued in [`phase2/14-POST-MVP-AMENDMENTS.md`](./phase2/14-POST-MVP-AMENDMENTS.md)). Architectural or product deviations require an explicit, owner-approved amendment recorded in doc 14 — never a silent change.
3. **Divergences are flagged, never silently resolved.** Where a phase2 spec and the code disagree, check doc 14 first — several specs are the *stale* side (template count, commercial tiers, S8 onboarding shape) and the divergence is already recorded. Anything new: record it, don't paper over it.

## Hard rules (subset — the Bible has the full set)

- The `job` and its operational event stream are the centre; never reorganise toward ERP/departments.
- No feature bypasses tenant isolation: all data access through `src/platform/tenancy` (ESLint-enforced); **every tenant-owned table carries `org_id` and gets RLS in the same migration** (user-owned pre-org data is user-scoped RLS).
- **The AI configuration boundary is constitutional**: AI/generated setup may only produce validated configuration through the schema'd proposal/revision pipeline — never code, SQL, DDL, RLS policies, or migrations.
- Money: `bigint` minor units, currency-aware exponents (KWD/BHD/OMR = 3), VAT recorded never assumed; money paths need golden-file tests.
- Derived values are computed by exactly one owner; never hand-set. Closed vocabularies live only in `src/platform/registries.ts`.
- No hardcoded domain nouns in UI (lint-enforced) — terminology resolver only. English + Arabic ship together; RTL-first with logical CSS properties; 44px touch targets on field flows.
- Complete the PR checklist (`.github/PULL_REQUEST_TEMPLATE.md`) honestly; label AI-authored PRs `ai-authored`.
