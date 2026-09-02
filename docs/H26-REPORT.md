# H26 — Document Studio: completion report

Owner summary first; the evidence follows. Decisions, research and the
per-slice log live in `docs/H26-TRUTH-MAP.md` (Parts A–G).

## What is live

The **Document Studio** is a governed document system inside IdaraWorks,
released behind `FEATURE_DOCUMENT_STUDIO` (the only enabling value is `"1"`):

- **Documents as living records.** One authored object per document
  (`doc_document`) with a working revision, frozen revisions with SHA-256
  content hashes, and one **immutable issued snapshot** (resolved bindings,
  issuer identity, branding and fonts frozen at issue). Lifecycle: draft →
  review → approval → signature → active → expired / terminated / superseded /
  archived, with retention stamped at issue (default 7 years, minimum 5, can
  only be lengthened) and legal hold. Every move lands in a **hash-chained
  timeline** (`doc_event`) that the UI verifies; a tampered event is detected.
  An issued or signed document cannot change silently: the API refuses, and
  database triggers refuse raw SQL too.
- **Interactive builder.** Drag-and-drop blocks (heading, paragraph, clause,
  list, table, line items, field, binding, signature, image, page break, note,
  section), inspector, undo/redo, keyboard shortcuts, autosave guarded by
  `row_version`, live preview through the shared document shell, EN/AR and
  bilingual documents with correct RTL.
- **Live records.** Bindings resolve customer, supplier, employee, quote,
  invoice and job fields under the acting person's permissions; computed
  expressions; conditional sections (a deposit section appears when the
  amount is at least AED 50,000; party-filled conditions are decided by the
  answers).
- **Governed templates.** Six built-in templates (NDA, service agreement,
  offer letter, cover letter, intake form, supplier agreement) and
  organisation templates with immutable published versions that documents pin.
- **Visual workflows.** A designer for sequential and parallel steps with
  conditions (amount, category, language, counterparty, signatures), delegation,
  escalation, due dates, rejection/resubmission and separation of duties; runs
  are orchestrated above the shared approvals engine (`document_step` subject),
  so document approvals appear in the same inbox as every other approval.
- **Collaboration.** Comments anchored to blocks, mentions, suggested changes
  with accept/reject applied under the row-version guard, revision compare
  (block and word diff), presence.
- **Signature room.** Native **electronic signature with an evidence record**
  (identity as asserted, verification method, server time, IP, user agent,
  locale, consent text version, snapshot hash) hashed into the chain: members
  sign in-app; external parties receive one-time hashed invitations that expire,
  can be revoked, and die with their request; the last signature activates the
  document; evidence lines are printed in the PDF. UAE PASS is a declared
  provider that **fails closed** with one owner action. IdaraWorks does not
  claim qualified, advanced, approved or government-certified signatures.
- **Forms.** Issued forms get hashed, expiring, use-capped public links; answers
  are validated against the issued snapshot (kinds, required, choices,
  conditional sections) and land in a quarantined row through a definer-only
  insert path (there is no application-role INSERT on the submissions table);
  a reviewer converts them into a customer, lead or document with an explicit
  field mapping, under their own permissions.
- **Obligations and renewals.** Payments, notices, reviews, renewals and risks
  per issued document with evidence-gated completion (immutable once done),
  recurrence, waive/cancel/reopen with reasons, escalation with notifications,
  a renewal decision seeded at issue from the expiry, due states computed on
  read against the organisation's reminder window, a daily reminder worker
  (registered; runs once Inngest is provisioned), and list / timeline /
  calendar / by-document views on the hub and per document.
- **Command centre.** An attention strip (overdue, due soon, expiring, waiting
  on me, awaiting signature, form answers), KPIs, filters, saved views, list /
  board / timeline / relationship-graph layouts (React Flow, lazy-loaded), and a
  keyboard command palette (Ctrl/Cmd+K).
- **Real PDF.** Server-side rendering from the governed snapshot with Noto Sans
  and Noto Naskh Arabic embedded, page numbers, watermarks (draft/void), the
  evidence block, and an `x-document-hash` header equal to the stored snapshot
  hash. Verified on the downloaded bytes, not only the preview route.
- **Assistant seam.** A provider-neutral seam through the platform's single
  agent provider: summaries, questions answered with citations validated
  against the document's clauses (or an explicit "evidence was not found"), and
  obligation proposals that persist nothing until a person adds them. It never
  issues, approves, signs, alters or terminates anything and is never presented
  as legal advice. **It is off in production** (no model provider) and says so.
- **Permissions and security.** Twelve document lanes in the authorisation
  matrix (foreman none, viewer view only); org_id + RLS on all 17 tables,
  composite (id, org_id) foreign keys, column-scoped UPDATE grants, no DELETE
  grants; public token pages resolve through SECURITY DEFINER functions with a
  synthetic context; the bleed harness proves every table is org-pure.
- **EN/AR, RTL, responsive.** Every screen and both public pages in English and
  Arabic; bilingual documents set English runs in Noto Sans and Arabic in Noto
  Naskh; desktop, tablet and 375 px walks are part of the evidence.

## Capabilities disabled for lack of a provider (one owner action each)

| Capability | State | Owner action |
| --- | --- | --- |
| External signature provider (UAE PASS) | declared, fails closed | contract the provider, then set its credentials in the provider adapter (`src/modules/docstudio/providers.ts`) |
| Assistant (summaries, Q&A, proposals) | off, fails closed | configure a model provider behind `getAgentProvider()` and enable `feat.ai_agents` for the organisation |
| Email delivery of invitations and reminders | link shown once in-app when unset | set `RESEND_API_KEY` (existing OA-4) |
| Daily reminder worker | registered, never fires until Inngest exists | provision Inngest (existing owner action); due states are computed on read regardless |

## Honest limitations

- Signatures are **electronic signatures with an evidence record**, suitable
  where the parties accept electronic form. They are not qualified or advanced
  signatures under eIDAS or the UAE Electronic Transactions law, and no
  certificate or qualified timestamp is produced (Truth map Part C).
- Retention deletes nothing; "eligible for disposal" is a human, audited
  decision.
- The optional 3D relationship view was not built (the lazy 2D graph is
  sufficient and a 3D view would add a 799 KB chunk for no operational gain).
- Reminders depend on the worker for push; without Inngest they are visible on
  read (due states, attention strip) but not pushed to the inbox daily.

## Verification (all on the exact shipped commit)

- **Gates:** prettier clean; `tsc --noEmit` clean; eslint 0 errors 0 warnings.
- **Unit:** 94 files, 1455 tests green (block vocabulary, hashing and chain
  verification, expressions, conditions, diff, renderer, due states,
  issue-time visibility, registries, flags, workspace laws, export catalogue).
- **Integration on the TEST project:** `h26a-foundation` 12, `h26d-workflows`
  6, `h26e-collab` 4, `h26f-signatures` 6, `h26g-forms` 5, `h26h-obligations`
  5, `h26i-ai` 2, `h26k-pdf` 2, `h26l-invariants` 5; bleed harness 2/2 with
  the 17 `doc_*` seeders.
- **Headless UI walk (dev server, Playwright):** 60+ screenshots across the hub
  layouts, builder, inspector, review, workflow designer, issued preview and
  activity, rendered EN/AR documents, real PDF bytes (4 pages, both faces
  embedded, hash header), public signing page EN/AR/mobile, public form page
  (validation problems, submission, AR, mobile), forms inbox, obligations
  (list/timeline/calendar/by-document, evidence dialog), assistant (unavailable
  state), command palette, Arabic hub/builder/preview, mobile hub/builder/new/
  obligations/forms. Every walk ended with `errors: none`.
- **Build:** `next build` green; all `/documents` routes dynamic.
- **Bugs found only by verification** (recorded in Part G): snapshot pruning of
  party-gated sections; nested `<html>` on public pages; foreign revision via
  `?rev=`; Latin glyphs in bilingual PDFs.

## Deployment (2026-09-02, all steps in order)

- **Shipped commit:** `60f61ce` on `main` (fast-forwarded from `verify/h26`;
  the deployed hash equals the CI-tested hash). Production deployment
  `idaraworks-nseunfebs` on Vercel, aliased to https://www.idaraworks.com.
- **CI on the exact commit:** green, run 167
  (https://github.com/thisisalm3azb/idaraworks/actions/runs/33653343527):
  quality (format, lint, typecheck, unit, audit, build, e2e smoke) and
  integration (every suite including all H26 suites and the bleed harness on
  CI's own Supabase stack). Run 166 at the previous commit failed only on
  `prettier --check .` for `.claude/launch.json`, fixed by formatting that file.
- **Read-only baseline before anything:** `prod-health.ts` HEALTHY (113
  applied, 6 pending, 0 tables without RLS, no unexpected DELETE grants, 0 new
  orphan identities or sessions); `h26-deploy-preflight.ts` CLEAR (pending =
  exactly 0114–0119; every live `file.access_class`, `approval.subject_type`
  and `approval_rule.subject_type` value inside the widened CHECK lists;
  helpers present; no `doc_*` tables; baseline orgs 39, users 60, jobs 93,
  quotes 46, invoices 78, approvals 13, files 2).
- **Migrations:** `migrate-prod.ts --confirm=…` applied exactly
  0114_h26a_document_foundation, 0115_h26a_terminated_check,
  0116_h26d_workflow_runs, 0117_h26f_signature_room, 0118_h26g_forms,
  0119_h26h_obligations. Afterwards: 119 applied, 0 pending, 17 `doc_*`
  tables (all RLS, all empty), the six `app.*` functions present,
  `cap.documents` on the four plans, HEALTHY.
- **Flag off, backend smoke on the deployed app:** `h26-prod-smoke.ts`
  **29/29** — lifecycle through the real services (issue, signature room with
  in-app and one-time-link signing, activation, evidence chain, obligations
  with evidence gate and recurrence, governed workflow decided through the
  shared approvals engine, public form submission and conversion, assistant
  fails closed, viewer refused, other organisation sees nothing) and every
  H26 HTTP surface answering not-found; residue 0; counts intact.
- **Deploy and health:** `/api/health` reported commit `60f61ce`, ok:true.
- **Flag on:** `vercel env add FEATURE_DOCUMENT_STUDIO production --value 1
  --yes` (listed in `vercel env ls production`), then `vercel redeploy` of the
  same build (Ready in 4 m, aliased); `/api/health` still `60f61ce`.
- **Flag on, smoke:** `h26-prod-smoke.ts --surfaces=on` **30/30** — hub
  renders, the PDF route streams real bytes (200, application/pdf, 3 pages,
  Noto Naskh embedded) with `x-document-hash` equal to the stored snapshot
  hash, the public form renders, a used signing link answers honestly;
  residue 0; counts intact.
- **Flag on, real UI walk:** `h26-prod-ui-walk.ts` — token-hash sign-in, hub,
  builder, issued preview, obligations, forms inbox, templates, workflows, real
  PDF download (67,561 bytes, 3 pages, both faces), public form page EN and AR,
  Arabic hub and preview (`dir=rtl lang=ar`), mobile hub/builder/obligations at
  375 px; **errors: none**; residue 0; counts intact. Screenshots in
  `.h26-shots-prod/` (not committed).
- **After everything:** `prod-health.ts` HEALTHY (119 applied, 0 pending, 0
  tables without RLS, no unexpected DELETE grants, orgs 39, users 60, 0 new
  orphan identities or sessions). Zero-residue proof: 17 `doc_*` tables at 0
  rows, 0 smoke markers, 0 fixture users, 0 fixture organisations, 0
  `tenant-docs` storage objects. The TEST project's UI fixture was wiped.

### Exact final owner actions (each capability fails closed until done)

1. Assistant: configure a model provider behind `getAgentProvider()`
   (`src/platform/agents/provider.ts`) and enable `feat.ai_agents` for the
   organisation.
2. External signatures (UAE PASS): contract the provider and set its
   credentials in the adapter (`src/modules/docstudio/providers.ts`).
3. Email delivery of invitations and reminders: set `RESEND_API_KEY` (OA-4).
4. Daily reminder pushes: provision Inngest (runbooks/inngest-provisioning.md).

## Untouched, as mandated

Historical accounting records were not converted; the H24 transition
ambiguities were not decided; PO-002 was not modified; no H22 inventory fixes
were mixed in; **H27 was not started**; existing production data and unrelated
user changes were preserved (historical counts verified before and after every
production script).
