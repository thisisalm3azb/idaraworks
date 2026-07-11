# 07 — Terminology-Resolution System

**Purpose:** the layer (v2 E2) that lets a boat builder see "Boats/القوارب", a contractor "Jobs", a maintenance firm (P4) "Work Orders" — over one canonical schema — without forking UI code. This is also where Arabic-first stops being a translation exercise and becomes product identity.

## D-7.1 — Two layers: static i18n strings + injected domain terms

**Decision:** UI copy lives in ordinary i18n message catalogs (`en`, `ar`, ICU MessageFormat). **Domain nouns are variables** inside those messages, resolved at request time from the terminology map: `t('report.submit_cta', { job: term('job', ctx) })` → "Submit today's report for {job}" → "Boat 24C-003" / "القارب 24C-003". Messages never hardcode a domain noun; a lint rule scans catalogs for the banned literal nouns.
**Why:** keeps translation (professional, slow-changing, versioned with code) separate from tenant vocabulary (config, fast-changing, per-template) — conflating them would mean every template × language needs a full message catalog.
**Alternatives rejected:** full per-template message catalogs (N×M explosion, unmaintainable); string search-and-replace at render (grammar disasters in Arabic — gender/number agreement breaks); no terminology layer, "Job" everywhere (v2 E2 exists precisely because retrofitting this is impossible).
**Risks:** grammatical agreement — Arabic adjectives/verbs agree with the noun's gender. Mitigation: term entries carry **grammatical metadata** (`gender`, and per-language plural forms), and message catalogs use ICU `select`/`plural` on that metadata. This is the hard 10% and is why term entries are structured objects, not strings.
**Validate in pilots:** native Arabic review of all foreman/owner flows with template #1 terms (R12); zero grammar bug reports post-fix round two.

## D-7.2 — Resolution order and renameability boundaries

**Resolution (first hit wins):** org override → template terminology map → platform default — each keyed by `(term_key, language)`.

**Renameable (domain nouns only — catalogue extended per audit C-9):** `job` (s/pl), `job_stage`, `daily_report`, `material_request`, `purchase_order`, `goods_receipt`, `expense`, `payment`, `task`, `issue`, `customer`, `supplier`, `employee`, `team`, `quote`, `invoice`, stage names (via stage_template), category names (via category_sets), preset names. (`week_plan` removed with the entity, audit F-15.)
**Fixed (platform chrome):** Today, Approvals, Money, People, Reports, Settings, notification/security/billing vocabulary, semantic status *categories*. **Why the boundary:** renaming chrome breaks documentation, support conversations, and tutorials; renaming domain nouns is the whole point. Orgs renaming "Approvals" to "Permissions" would create support chaos for zero operational value.
**Alternatives rejected:** everything renameable (support/localisation chaos); nothing org-overridable (real orgs have house vocabulary — Najolatech says "LPO", not "PO"; template #1 ships `purchase_order → "LPO"` as exactly such an override-style term).

## Term entry shape (config schema in doc 09)

```jsonc
// terminology_map entry — specification example
"job": {
  "en": { "singular": "Boat", "plural": "Boats", "article_hint": null },
  "ar": { "singular": "قارب", "plural": "قوارب", "gender": "m" }
}
// `dual` dropped from the required schema (audit F-20) — no shipped UI string needs it; reserved as optional.
```

Keys are the closed canonical catalog above (code-owned registry; templates/orgs supply values, never new keys — same registry discipline as docs 02/05). Values are validated: required languages = org's enabled languages; length caps; no markup.

## Reference patterns

Job references (hull-number generalisation) are part of terminology's remit: template supplies a pattern `"{preset_code}-{seq:3}"` (→ `24C-003`), org override allowed, sequence per org (+ per preset where the pattern uses it). Serial documents (PO/invoice/receipt/contract) use the same pattern engine with org-configurable **starting numbers** (the paper-LPO-27 requirement, doc 01).

## Numerals (audit F-44)

Western digits (`u-nu-latn`) are **pinned as the default numbering system under `ar` locales**, with a per-org override — unpinned ICU renders amounts as ٥٬٠٠٠ under `ar-SA`, and GCC business documents overwhelmingly use Western digits. A doc-10 test asserts formatted money/dates under `ar` use Latin digits by default.

## Tooling & enforcement (CI, doc 10 items)

1. **Catalog lint:** banned-literal scan (no "job/boat/project" hardcoded in messages or components); every user-visible string flows through `t()` (existing i18n lint pattern).
2. **Key coverage test:** every canonical term key resolves in `en` and `ar` for every shipped template — fails the template build, not runtime.
3. **Pseudo-locale render test:** UI snapshot with exaggerated long terms + RTL to catch truncation/layout breaks.
4. **Runtime fallback:** missing term → platform default + logged warning; never a raw key on screen.

**RTL note (scope guard):** terminology resolves *words*; RTL layout is the design system's job (v1 R12 — RTL-first components, logical CSS properties, direction-aware icons). This document deliberately does not own RTL beyond term metadata.
