# 02 — Container-Contract Specification

**Purpose:** define the one abstraction v2 §8 permits ahead of need: the narrow interface through which every cross-cutting engine (tasks, daily reports, issues, approvals, evidence, comments, activity, costing, exceptions) sees the operational object. This contract is what lets a second object kind (e.g. maintenance work order, P4+) arrive without rewriting the engines — while the MVP stays a concrete, job-centred system.

All code in this document is **specification pseudocode** (TypeScript-flavoured), not production code.

---

## D-2.1 — The contract is a code-level interface, not a database-level polymorphism

**Decision:** engines consume a `WorkContainer` interface resolved by the service layer. In the database, execution engines carry a **concrete `job_id` foreign key** in MVP. Only the *attachment engines* (files, comments, activity) use a polymorphic `(entity_type, entity_id)` pair — because they must attach to many entity types (tasks, invoices, expenses…) from day one regardless of the container question.

**Why:** concrete FKs give referential integrity, natural indexes, and honest query plans on the hottest paths (daily reports, costing) — the paths that make Today truthful. The contract's job is to keep *code* portable, not to make the *schema* generic before a second kind exists.

**Alternatives rejected:**
- *Polymorphic `(container_type, container_id)` on every engine table now* — loses FK integrity and index locality on the core spine for a hypothetical future; this is R16 (abstraction trap) in schema form.
- *Single giant `containers` supertype table with per-kind satellite tables now* — a real option **later**; building it at N=1 kinds means designing the supertype from one example (v2 §8.3 reason 3).
- *No contract at all, engines import job internals freely* — makes the P4 second-kind decision a rewrite; violates v2 E3.

**Risks:** the interface may still encode job-shaped assumptions (see §"assumption audit" below — three fields are flagged nullable-by-design). When kind #2 arrives, the DB-level choice (add `work_order_id` columns vs migrate to supertype) is deliberately deferred; both paths are kept open and documented here so it's a decision, not an excavation.

**Validate in pilots:** that no pilot-driven feature request forces an engine to reach around the contract into job internals — every such request is logged as a contract-pressure event and reviewed.

---

## The contract

```ts
// Specification pseudocode — Phase 2 artifact, not production code.

type ContainerKind = 'job';                    // MVP: exactly one. P4+: union grows.
type StatusCategory = 'draft' | 'active' | 'on_hold' | 'done' | 'cancelled';
type PhaseSemantic  = 'preparation' | 'production' | 'finishing' | 'verification' | 'handover';
// Semantic anchors (v2 §8 E4): fixed vocabularies engines may switch on.
// Template statuses/stages MAP to these; engines never parse tenant labels.
// AUDIT F-19: PhaseSemantic is an N=1 abstraction — MVP engines may consume ONLY two
// derived predicates, isReportable(phase) and isPreFinal(phase), never the raw enum,
// so the phase vocabulary can be re-cut at template #2/#3 authoring without engine changes.

interface WorkContainerRef {
  kind: ContainerKind;
  id: UUID;                                    // = job.id in MVP
  orgId: UUID;                                 // always present; engines re-verify tenancy
}

interface WorkContainer extends WorkContainerRef {
  reference: string;                           // human ref, e.g. "24C-003" (per-org, template-patterned)
  displayName(ctx: TerminologyCtx): string;    // resolved via doc 07 — engines NEVER hardcode "Job"/"Boat"
  statusCategory: StatusCategory;              // semantic, not the tenant label
  customerId: UUID | null;                     // null allowed: internal jobs (yard maintenance, R&D)
  dates: { start: Date | null; due: Date | null; completed: Date | null };
  currentPhase: PhaseSemantic | null;          // null for kinds without phases (future short-lifecycle kinds)
  assigneeIds: UUID[];                         // people currently responsible
  money: MoneyRollup;                          // read-only, computed — see below
}

interface MoneyRollup {                        // ALWAYS derived (v2 §11 invariant), never stored by hand
  currency: CurrencyCode;                      // org currency (single, MVP)
  quotedMinor: bigint | null;                  // precedence (audit C-10): accepted quote total
                                               // (+ audited price adjustments) → else job.selling_price
                                               // → else null; divergence raises an exception
  costMinor: bigint;                           // costing spine rollup (doc 01)
  invoicedMinor: bigint;
  paidMinor: bigint;
}
```

### What engines may do with a container

| Engine | Uses from contract | Must NOT use |
|---|---|---|
| Daily reports | ref, reference, displayName, statusCategory (block reporting on `done`/`cancelled`), assigneeIds (authz condition) | stage internals — the report *references* a stage id passed as data, but stage semantics live in the job capability, not the report engine |
| Tasks | ref, dates (default due bounds), assigneeIds | phase logic |
| Issues | ref, displayName (notifications) | — |
| Approvals | ref (approvable subject linkage), money (threshold rules read amounts from the approvable, not the container) | — |
| Costing | ref, money (it *writes* the rollup via its own ledger — the only engine that populates MoneyRollup) | — |
| Evidence/files, comments, activity | polymorphic attach — container is just one of many attachable types | — |
| Exceptions (doc 04) | ref, statusCategory, currentPhase, dates, money | tenant status labels |
| Today (doc 03) | everything above, read-only, via card queries | — |

### Assumption audit — job-shaped fields deliberately marked

Three contract fields would not fit every future kind and are therefore **nullable/optional by design**, with engine behaviour defined for the null case now: `customerId` (internal jobs exist even in MVP), `currentPhase` (a future ticket-like kind has none — engines must render phase-less containers), `dates.due` (open-ended internal work). This is the cheap version of future-proofing: not building kind #2, just refusing to *assume its absence* in signatures.

### Registry, not strings

`ContainerKind`, `StatusCategory`, `PhaseSemantic`, the approvable-type registry (doc 05), and the attachable-type registry (files/comments/activity) are **closed, code-owned enums**. Tenants and templates map onto them; nothing tenant-authored extends them. (Configured-not-customised, applied to type systems.)

---

## D-2.2 — MoneyRollup is computed by the costing engine only; the contract exposes it read-only

**Decision:** exactly one writer (the costing engine's ledger rollup); all other engines and all UI read. **Why:** v2 §11's "derived, never hand-entered" invariant needs an enforcement point; a single writer makes "why is this margin wrong?" a one-module investigation. **Alternatives rejected:** per-engine incremental updates to a stored total (drift, race conditions); compute-on-every-read with no cache (Today would hammer the ledger — rollups are cached with event-driven invalidation instead). **Risks:** invalidation bugs show stale money on Today — mitigated by the freshness metadata (doc 03) applying to money cards too, and a nightly full-recompute reconciliation that alerts on drift ≠ 0. **Validate in pilots:** rollup-vs-recompute drift alarm stays silent for the whole pilot; if it fires, the event-invalidation map is incomplete.
