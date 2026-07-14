# Template Configuration Reference

How templates are built, validated, installed and resolved. Source of truth: `src/platform/config/templates/` (manifests, `blocks.ts`, `catalogue.ts`, `index.ts`), `src/platform/config/schemas/{manifest,artifacts}.ts`, `src/platform/config/install.ts`, `src/platform/terminology/`.

## 1. What a TemplateManifest contains

A template is a **pre-validated bundle of ordinary config artifacts** — nothing in it has special write powers; every piece is the same artifact an org admin could author by hand in Settings → Configuration. `TemplateManifestSchema` (`schemas/manifest.ts`) validates each artifact AND the referential closure between them; shipped templates are validated by a build-time unit test, so a broken template fails the build, never an install.

| Field | Artifact / schema | Key constraints |
|---|---|---|
| `key` | — | `^[a-z][a-z0-9_]{0,49}$`; identity shared with the catalogue entry |
| `version` | — | integer ≥ 1 |
| `object_kind` | — | one of the container kinds (currently `job`) |
| `terminology` | `TerminologyOverrideSchema` | per-term en/ar singular+plural (+ Arabic gender); only keys whose domain language differs from platform defaults |
| `stage_template` | `StageTemplateSchema` | ≥1 stage; **weights are integers 1–100 and MUST sum to exactly 100**; unique `stage_key`s; each stage carries a `phase_semantic` from the closed registry (preparation / production / finishing / verification / handover) |
| `status_sets.job` | `StatusSetSchema` | unique `status_key`s; **semantic anchors: the job set must map every required category — draft, active, done, cancelled** (on_hold is optional); labels bilingual; explicit `sort` order |
| `category_sets.{item,expense,quote_section}` | `CategorySetSchema` | `kind` must match the slot; unique keys; **every expense category REQUIRES a `costing_mapping`** (audit F-2) from `job_materials` / `job_other` / `overhead`; `retired` flag — categories are retired, never deleted (D-9.2) |
| `reference_patterns.job` | `ReferencePatternSchema` | **closed token grammar**: literal pattern-safe chars (`A-Za-z0-9{}:_-/`, ≤40) plus exactly the tokens `{preset_code}`, `{year}`, `{seq:n}` — unknown braces rejected; **exactly one `{seq:n}` token required**; `start` ≥ 1 for paper-continuity numbering |
| `role_presets` | `RolePresetSetSchema` | 1–12 roles; **the 7 bootstrap role KEYS are fixed platform-wide** (owner/admin/manager/foreman/procurement/accounts/viewer — they must match the `role_definition` rows created at org bootstrap); each role carries an `archetype` from the grantable set plus `cost_privileged` / `price_privileged` flags — templates vary only LABELS and the manager's money-visibility |
| `presets` | `JobPresetSchema[]` (≥1) | `code` is 1–8 uppercase letters/digits (feeds `{preset_code}`); unique codes; `default_skipped_stage_keys` ⊂ stage template keys; **`billing_points` MUST sum to exactly 100%**, each trigger either `"on_acceptance"` or `{ stage_key }` referencing an existing stage |
| `holiday_calendars` | `Record<ISO-country, HolidayCalendarSchema>` | ≤100 entries; `ends_on` ≥ `starts_on`; optional Ramadan working-hours profile (F-41); install picks the org's country |
| `field_definitions.{job,customer}` (optional) | `FieldDefinitionSetSchema` | ≤30 fields; immutable `field_key`s; select/multiselect need options (≤50); `visibility` is a list of archetypes (empty = everyone) |

**Referential closure** (`superRefine` on the manifest): every preset's skipped stage keys and billing-point stage triggers must exist in the stage template; preset codes unique; each category set's `kind` matches its slot; every expense category has a costing mapping. All tenant-facing strings pass the shared sanitiser (`configString`); keys are immutable snake_case identities, labels are mutable.

## 2. The catalogue entry (selection metadata)

`TemplateCatalogueEntry` (`catalogue.ts`) wraps the manifest with what the chooser, the classifier and the docs display: bilingual `names` / `description` / `targetBusinesses`, `classificationPhrases` (≥6) and `classificationKeywords` (≥6) for the deterministic matcher, `enabledModules` / `optionalModules` (**advisory UI defaults over existing capability keys — NEVER entitlements**), `dashboardDefaults` (keys of existing Today cards), and a **required, non-empty `limitations` list** — honesty by construction. `entryIsCoherent()` guards key parity (entry key === manifest key) and the minimums; the registry (`index.ts`) derives `TEMPLATES` from `TEMPLATE_CATALOGUE` so a manifest cannot exist without selection metadata or vice versa.

## 3. The shared-blocks API (`blocks.ts`)

Templates are composed from shared blocks instead of copy-pasting structure — one place owns the spines so eight manifests cannot drift. Blocks return **new objects on every call** (manifests stay independently mutable) and everything remains plain data validated at build time — **no block has install-time behaviour**.

- **`L(en, ar)`** — bilingual label helper; every template label carries en + ar.
- **`gccHolidayCalendars2026()`** — shared AE + SA 2026 calendars (public holidays, Eid ranges, Ramadan 6-hour profile). Install picks the org's country, falling back to the first shipped (AE). Org-editable after install — the calendar is config, not law.
- **`standardRoles(labels?, opts?)`** — the 7-role spine. Overridable per-role LABELS only; `opts.managerSeesCosts` / `opts.managerSeesPrices` toggle the manager's money flags. Invariant: owner/admin/accounts stay cost+price privileged; foreman/procurement/viewer never see money.
- **`standardJobStatuses(overrides?)`** — the status spine covering every required semantic anchor (draft/active/done/cancelled + on_hold). Templates rename the ACTIVE and DONE statuses to their domain language and may append `extraActive` statuses (inserted between on_hold and completed with correct `sort` values).
- **`commonExpenseCategories(extras?)`** — the expense costing spine (audit F-2): materials → job_materials; labour/outsourced/transport → job_other; fuel/tools/rent → overhead; `extras` are inserted after the spine, before "other", and each must carry its own costing mapping.

Boatbuilding (`boatbuilding_marine_v1`) predates the blocks and carries its verbatim production content inline (custom status set, 17/13/9 category lists, inline calendars); all other templates compose from the blocks.

## 4. How install works (`install.ts`)

An install is a **SEQUENCE of ordinary `applyConfigChange` calls** — one `config_revision` per artifact, each individually diffable and undoable. Nothing is seeded: no jobs, users, suppliers or transactions.

1. `getTemplate(key)` — registry lookup + defensive re-validation against `TemplateManifestSchema` (a broken registry entry fails here, never half-way through).
2. **Idempotence guard** — the `config.template` marker in `app_settings` blocks a second install (jsonb-null counts as "unset", i.e. an undone install marker does not block). Re-configuration is per-artifact editing; switching templates is a post-MVP migration story.
3. **Entitlement gate** — preset count ≤ `limit.presets` for the org's plan.
4. **Country pick** — the org's country selects one holiday calendar (F-41); fallback: first shipped.
5. **Artifact sequence, order matters** (stage template before presets — preset guards read it): `config.stage_template` → `config.status_set.job` → `config.categories.item` → `config.categories.expense` → `config.categories.quote_section` → `config.reference_patterns` → `config.roles` → `config.holiday_calendar` → `config.fields.job` / `config.fields.customer` (if present) → `terminology.template` (the manifest key) → one `preset.{id}` per job preset → finally the **`config.template` marker** `{ key, version }`.
6. **Idempotent retry** — preset revisions reuse the EXISTING `job_preset` row id per code, so a repeated install (after a mid-sequence failure or an undone marker) upserts the same rows instead of colliding on the unique code constraint. Re-running the sequence converges, never wedges.

The `config.template` marker is written LAST — it is both the "install complete" flag and the idempotence key; `terminology.template` is what the terminology resolver reads.

## 5. Terminology resolution layering

Resolution (`src/platform/terminology/`) is a strict three-layer fallback, resolved once per request via `loadOrgTerminology`:

```
org override (app_settings "terminology.overrides")
  → template map (app_settings "terminology.template" → TEMPLATE_TERMS[key])
    → platform default (PLATFORM_DEFAULT_TERMS)
```

The loader reads both `app_settings` keys, validates the override blob defensively, and hands the resolver a ready `TermContext { locale, overrides, templateKey }`. The S1 config pipeline is the only writer. A founder-renamed job term during onboarding becomes a `terminology.overrides` artifact in the proposal (see AI_TEMPLATE_SELECTION_RULES.md) so the chosen words are actually applied, not just echoed; plural forms remain editable in Settings.

## 6. Authoring a new template — checklist

1. **Create `src/platform/config/templates/<name>.ts`** exporting a `TEMPLATE_<NAME>: TemplateManifest` and a `TEMPLATE_<NAME>_ENTRY: TemplateCatalogueEntry`. Compose from `blocks.ts` (`standardRoles`, `standardJobStatuses`, `commonExpenseCategories`, `gccHolidayCalendars2026`) — do not copy-paste spine structure.
2. **Key** — snake_case with a `_v1` suffix; the entry `key` must equal the manifest `key`.
3. **Terminology** — override only the keys whose domain language differs from the platform default; every label bilingual (en + ar, with Arabic gender).
4. **Stages** — integer weights summing to exactly 100; each stage mapped to a phase semantic; keys immutable snake_case.
5. **Statuses** — use the spine; rename active/done; append extra active statuses only where the domain genuinely stalls (e.g. Awaiting Parts).
6. **Categories** — every expense category carries a costing mapping; end lists with an `other` catch-all; keys immutable, labels mutable, `retired` never deleted.
7. **Presets** — ≥1, unique 1–8-char uppercase codes; billing points sum to 100 per preset; skipped stages must exist in the stage template; add a `description` explaining the billing logic.
8. **Reference pattern** — exactly one `{seq:n}`; only `{preset_code}` / `{year}` / `{seq:n}` tokens.
9. **Catalogue entry** — ≥6 classification phrases and ≥6 keywords (mixed en + ar, lowercase, strong domain signals only); ≥3 honest `limitations`; advisory modules referencing existing `cap.*` keys only; dashboard defaults from the existing Today card keys.
10. **Register** in `index.ts` — import both exports and append the entry to `TEMPLATE_CATALOGUE` (generic stays last as the fallback).
11. **Run the gates** — `pnpm test` and `pnpm typecheck`.

### Build-time tests that gate a template

`tests/unit/templates-catalogue.test.ts` validates EVERY shipped template:

- registry contains exactly the expected keys, unique;
- each manifest passes `TemplateManifestSchema` (weights Σ=100, billing Σ=100, semantic anchors, referential closure);
- `entryIsCoherent` (key parity, classification-data minimums) and ≥3 limitations;
- bilingual completeness of names, description, target businesses, limitations;
- stage weights sum to 100 and roles use the 7 bootstrap keys;
- **vocabulary-leakage guard**: marine/boat vocabulary (en + ar regexes) is allowed only in the marine template;
- dashboard defaults limited to the allowed Today card keys;
- advisory module keys ∈ `FEATURE_KEYS`;
- terminology resolves via `resolveTerm` against `TEMPLATE_TERMS`.

`tests/unit/template-classify.test.ts` covers the classifier (canonical phrases route to the right template, generic fallback, ambiguity), and `tests/unit/s8-onboarding.test.ts` covers proposal grounding and validation. A new template must not break the classification expectations of the existing eight — check for keyword collisions.
