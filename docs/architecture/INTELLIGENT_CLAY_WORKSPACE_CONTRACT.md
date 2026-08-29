# Intelligent Clay workspace contract (H14)

Status: binding architecture for workspace configuration. Implemented in
`src/platform/workspace/` with persistence in
`supabase/migrations/0075_workspace_blueprint.sql`. H15 onboarding will
PRODUCE blueprints through this contract; H16/H17 will RENDER the workspace
and dashboards FROM the applied configuration. Nothing renders from it in
H14 — every existing organization's behavior is unchanged.

## 1. Purpose, in plain language

Intelligent Clay is how IdaraWorks shapes itself around one organization.
The shape lives in a single, versioned document — the WORKSPACE BLUEPRINT —
that answers: what kind of business is this, which capabilities does it
need, what words does it use, how does its work move, which roles exist,
what should each role see first, which country rules apply, and which
agents are relevant. A deterministic COMPILER turns an approved blueprint
into derived configuration. A LIFECYCLE with explicit human approval, full
audit and undo governs every change.

Intelligent Clay configures the product. It never generates code, database
structure or security rules, and it never grants access: it can only narrow
and arrange what the platform, the plan and the permission matrix already
allow.

## 2. Truth map (Part A audit, 2026-08-29)

### Reused as-is (sources of truth this contract points at, never replaces)
- **Organizations**: `public.org` (country, timezone, base_currency,
  languages) + `company` issuer identity + `org_branding` + document
  profile (0074).
- **Membership and roles**: `role_definition` / `membership` (0003),
  `ROLE_ARCHETYPES` + `MVP_GRANTABLE_ARCHETYPES` (`registries.ts`).
- **Permissions**: the authz matrix (`authz/matrix.ts`) with `can()` —
  deny-by-default; blueprint writes reuse `config.manage`, reads
  `config.view` (no new actions).
- **Entitlements**: `entitlements/catalogue.ts` (closed FEATURE/LIMIT
  keys) + `resolveEntitlements` (plan → add-ons → overrides). Nothing in
  the blueprint system grants entitlements.
- **Terminology**: `TERM_KEYS` + `PLATFORM_DEFAULT_TERMS`
  (`terminology/catalogue.ts`) — canonical ids, en/ar forms with gender.
- **Workflows/stages**: the config artifacts (`config.stage_template`,
  presets, status sets) and the shipped snapshot-on-creation law
  (`job_stage` snapshots names/weights at job creation).
- **Navigation**: `buildNavGroups` (pure `can() ∩ features` law) — the
  workspace nav registry mirrors it and is parity-tested against it.
- **Dashboard**: `composeToday`'s real card keys — mirrored in a closed
  registry, parity-tested against the module source.
- **Audit/commands**: `command()` (audit_log + billing gate, atomic),
  `lockOrgConfig` (per-org advisory lock).
- **Config revisions + undo**: `config_revision` + `applyConfigChange` /
  `undoRevision` remain the write path for ARTIFACT-level configuration;
  the blueprint lifecycle uses the same append-only philosophy.
- **Onboarding**: the S8 `onboarding_session` (propose/apply/undo) and the
  U4 pre-org draft remain untouched in H14.
- **Country facts**: onboarding `SUPPORTED_COUNTRIES` / `COUNTRY_DEFAULTS`
  — mirrored into country packs, parity-tested.

### Extended
- `AUDIT_ENTITY_TYPES` gains `workspace_blueprint`.
- New closed registries name what was previously implicit: workspace
  modules (= the enforced `cap.*` keys), nav item keys, dashboard card
  keys, country packs, provenance sources, business-profile vocabulary.

### Conflicting configuration sources (documented, not resolved in H14)
- Template `enabledModules`/`optionalModules` are ADVISORY; entitlements
  are authoritative. The blueprint records intent + reason; the compiler
  intersects with the real plan.
- Template `dashboardDefaults: string[]` has drifted from the real Today
  card keys and is consumed by nothing; the blueprint's card vocabulary is
  the corrected, parity-tested replacement (H15 migrates the templates).
- The legacy coarse keys `cap.procurement` / `cap.expenses_costing` stay
  seeded for compatibility but are not workspace modules.
- `src/app/(app)/o/[orgId]/onboarding/page.tsx` duplicates the country
  list (drift risk; noted for a later cleanup — UI is out of H14 scope).

### Missing persistence (added in H14)
- Blueprint revisions with lifecycle state, approval binding, compiled
  output: `workspace_blueprint_revision` (0075). Smallest normalized
  schema; org-scoped RLS; no DELETE grant; DB-level immutability guard.

### Security boundaries
- All lifecycle entry points take a server-resolved `Ctx` + archetype
  (callers use `resolveCtx`/`resolveCtxForAction`), then `assertCan`.
- RLS: SELECT/INSERT/UPDATE gated to owner/admin archetypes inside the
  org (the `config_revision` idiom); INSERT additionally requires
  `created_by = current_user`.
- The DB guard trigger freezes approved/applied content and terminal
  states independently of the application layer.

### Migration requirements
- One expand-only migration (0075). No seeds, no backfill: zero applied
  blueprints exist after migration, and nothing reads the table yet, so
  every existing organization behaves exactly as before.

## 3. The Intelligent Clay laws

The twenty non-negotiable laws live in `src/platform/workspace/laws.ts`
and are pinned one-by-one in `tests/unit/workspace-laws.test.ts`. They are
the contract's constitution; the sections below implement them.

## 4. Effective access — one equation

```
effective capability = platform availability
                     ∩ plan entitlement
                     ∩ approved organization configuration
                     ∩ acting-user permission

agent-assisted action = the above
                      ∩ agent allow-list
                      ∩ action classification
                      ∩ approval state
```

Encoded in `src/platform/workspace/access.ts` as strict boolean
intersections with NO override input: a lower layer structurally cannot
override a higher one. The compiler evaluates the first three layers and
records them per module; the per-user layer intersects at read time via
`can()` (exactly how the nav builder already works). Precedence is
declared in `EFFECTIVE_ACCESS_LAYERS` and tested.

## 5. The blueprint schema (v1)

`WorkspaceBlueprintSchema` (`blueprint.ts`), `schemaVersion: 1`. Every
section is `.strict()` (unknown fields rejected — client-supplied
authority has nowhere to live), carries `provenance` (source, proposer,
time, bilingual reason, optional confidence), and localizes every
organization-facing label as a locale map requiring `en` AND `ar` while
accepting additional locale keys (future locales need no schema change).

1. **profile** — business model, industries, size band, markets served,
   customer types, work delivery, revenue models, physical/digital mode,
   operating locations.
2. **capabilities** — per-module `{key, enabled, reason}` over the closed
   module registry (the enforced `cap.*` keys). Dependencies and
   availability live in `MODULE_INFO`; entitlement requirements are the
   keys themselves.
3. **terminology** — overrides keyed by CANONICAL `TermKey` (identity
   never changes), en/ar forms with Arabic gender, explicit
   `fallback: "platform_default"`.
4. **workflows** — the `job` container: named stages with weights (sum
   100) and phase semantics, allowed transitions, required approvals
   (archetype must actually hold `approvals.decide`), responsibilities,
   exception paths, and the shipped `snapshot_on_creation` versioning law.
5. **roles** — archetype mapping, bilingual names/responsibilities,
   permission REFERENCES (validated against the matrix — an action the
   archetype lacks is a hard error), presentation-only nav visibility,
   relevant agents, approval-authority flag (validated, informational).
6. **navigation** — ordering + hiding over the closed nav-item vocabulary;
   safety-rail items cannot be hidden; `clientAuthority: "none"` is a
   structural literal.
7. **dashboards** — per-archetype outcomes, prioritized cards (each with a
   bilingual WHY), attention signals, decisions required, exceptions,
   time horizon — over the closed card vocabulary.
8. **international** — country pack (must exist), default locale,
   currency (kept separate from country), timezone, tax identity FIELDS
   (never values), VAT registration flag.
9. **agents** — canonical agent ids only; relevant roles/modules; read
   domains validated ⊆ the agent's canonical allow-list (narrowing only);
   classifications (never `prohibited`); the entitlement literal
   `feat.ai_agents`. No provider or model configuration exists in the
   shape.
10. **provenance** — embedded per section (see above).

## 6. Lifecycle

States: `draft → validated → approved → applied → superseded`, with
`rejected` terminal from draft/validated/approved.

- Draft creation/update stores intent only; content is hashed (sha256 of
  canonical JSON). Edits require the caller's expected hash — concurrent
  edits conflict, never merge silently. Any edit returns to `draft`.
- Validation produces structured `{errors, warnings}`, stored on the row;
  only a 0-error revision becomes `validated`.
- Approval requires `config.manage`, a `validated` revision and the exact
  content hash; it re-validates at the moment of approval and binds
  `approved_hash` to the server-resolved approver.
- Application requires `approved` status AND `approved_hash` still equal
  to the stored content's hash (recomputed — tamper check), compiles with
  the SERVER-resolved entitlement snapshot, supersedes the previous
  applied revision, and records a structured before/after (previous vs
  new compiled output) on the audit row. Exactly one applied revision per
  org (partial unique index). Re-applying the current applied revision is
  a safe no-op.
- Undo appends: it restores the predecessor blueprint as a NEW applied
  revision (`proposed_source: "undo"`, the undoing user is the
  authorizing human), or retires the only applied revision back to the
  unconfigured baseline. History is never rewritten.
- The 0075 guard trigger enforces at the DATABASE layer: approved/applied
  content is immutable, terminal states accept no changes, and only legal
  status transitions exist.

## 7. The compiler

`compileBlueprint(blueprint, platformSnapshot)` in `compiler.ts`;
`COMPILER_VERSION = "1.0.0"`. Pure and deterministic: no I/O, no clock,
no randomness (pinned by a source-scan test); identical inputs at the
same version always produce identical output.

Produces: effective capabilities (per module: config/plan/platform layers,
equation result, honest status `active | disabled_by_configuration |
unentitled | unavailable`, reason), resolved terminology for every
canonical key (override or platform default), workflow references,
role-to-navigation model (`can()` first, then module availability, then
presentation preferences), role-to-dashboard priorities (cards filtered to
live modules), agent relevance (allow-list-narrowed, entitlement-gated —
today always unentitled because `feat.ai_agents` is unregistered),
localization (country pack + the org's own choices, kept separate),
explanations (per-section provenance) and warnings (unentitled,
unavailable, non-default currency, disabled-module references).

The compiler never renders UI, modifies code or schemas, grants
permissions, activates entitlements, calls providers, executes tools,
deletes records, or invents modules — an invalid blueprint throws before
any of it (fail closed).

## 8. Persistence

`workspace_blueprint_revision` (0075): org-scoped, per-org revision
numbers, content + hash + validation + compiled output + full lifecycle
attribution (who proposed/approved/rejected/applied, when, why), RLS gated
to owner/admin, append-only grants (no DELETE), `set_updated_at` +
immutability guard triggers, deferrable self-FK for supersede-then-insert
undo. Nothing is seeded; no existing table changes.

## 9. Security

See the truth map §2 boundaries, the pure denial suite
(`tests/unit/workspace-security.test.ts`) and the DB suite
(`tests/integration/workspace-blueprint.test.ts`): forged org ids,
non-members and non-admin members read nothing (RLS); viewers/foremen/
procurement/accounts are refused before any I/O; smuggled entitlements,
approval states, provider settings and forged vocabulary never parse;
stale hashes refuse approval; tampered content refuses application;
duplicate application is a no-op; disabling modules deletes nothing;
every lifecycle action writes an audit row.

## 10. Internationalization

en and ar are first-class everywhere (required in every localized map,
Arabic gender on terms); additional locales are accepted structurally.
Country packs are DATA: defaults (timezone/currency), locales and
directions, Latin-numeral and date-format policy, tax identity FIELDS,
document identity fields, empty-until-shipped regulatory extensions, and
explicit unsupported assumptions. Currency remains a separate setting
from country. Packs carry no security surface (tested).

## 11. Relationships

- **Onboarding (H15)**: the questionnaire produces a DRAFT blueprint via
  `createBlueprintDraft(ctx, archetype, { blueprint, source:
  "onboarding_answer", reason })`, shows the validator's structured
  errors/warnings at review, and calls approve + apply only on the
  owner's explicit confirm. The existing S8 proposal/artifact path stays
  intact until H15 migrates it. **This is the exact H15 integration
  point.**
- **Workspace rendering (H16)**: reads `getAppliedWorkspace(ctx,
  archetype)` and treats `null` as today's behavior (fail closed to the
  current experience); navigation/terminology derive from the compiled
  output intersected with `can()` at request time.
- **Dashboards (H17)**: `composeToday` consumes the compiled per-role
  priorities the same way.
- **Agents**: agent relevance narrows the canonical registry; the H12
  runtime laws (allow-list ∩ can() ∩ entitlement ∩ classification ∩
  approval) are unchanged and restated in the equation.

## 12. Failure and recovery

Missing configuration → `null` applied workspace → consumers keep the
shipped default behavior. Invalid content → structured errors; it cannot
be validated, approved or applied. Hash mismatch or stale state →
explicit `BlueprintLifecycleError` codes (`stale_revision`,
`hash_mismatch`, `invalid_state`, `validation_failed`,
`nothing_to_undo`) — nothing partial ever applies (single command
transaction under the per-org config lock). Recovery is always forward:
fix the draft, re-validate, re-approve; or undo to the predecessor.
