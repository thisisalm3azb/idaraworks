# AI / Deterministic Template Selection Rules

How a founder's free-text business description becomes a template recommendation. Source of truth: `src/modules/onboarding/classify.ts` (the algorithm), `provider.ts` (selection precedence + proposal grounding), `validate.ts` (proposal validation). The deterministic classifier IS the shipped selection path — it needs no AI provider at all.

## 1. The deterministic algorithm (classify.ts)

Pure and transparent: same input → same output. The classifier scores the founder's description (`business_description + " " + business_name`) against every catalogue entry's `classificationKeywords` and `classificationPhrases` and returns the **full ranked list with the evidence for each score** — the preview shows WHY a template was recommended and every alternative, and the founder always chooses.

### Normalisation (`normalizeText`)

1. Lowercase (latin).
2. Arabic folding: strip tashkeel + dagger alef (`[ً-ْٰ]`); unify alef variants `أ إ آ → ا`; `ى → ي`; `ة → ه`.
3. Strip everything except letters/digits/whitespace (`[^\p{L}\p{N}\s]` → space); collapse whitespace; trim.

Both the description and every keyword/phrase are normalised before matching.

### Keyword scoring — +3 per hit

For each entry keyword:

- **Latin keywords/bigrams**: word-boundary regex match (`(?:^| )kw(?: |$)`) against the normalised text — no substring false hits ("art" never matches "particle").
- **Arabic keywords** (any Arabic char present): plain substring `includes` — Arabic morphology (attached prefixes like الـ/و) makes word-boundary matching too strict.

Each matched keyword contributes **+3**.

### Phrase scoring — +2 × ratio, threshold ≥ 50%

For each entry phrase:

1. Tokenise the normalised phrase into **informative tokens**: length ≥ 3 for latin, ≥ 2 for Arabic, excluding a stopword list (we/run/have/the/company/business/… + في/لدينا/نحن/شركه/محل/…).
2. `ratio` = matched tokens ÷ phrase informative tokens, where matched = tokens present in the description's own informative-token set.
3. If **ratio ≥ 0.5**, the phrase matches and contributes **+2 × ratio** (so a full overlap adds 2, a half overlap adds 1).

Total score = `keywordHits × 3 + Σ (2 × phraseRatio)`, rounded to 2 decimals.

### Ranking, fallback and ambiguity

- All 8 entries are scored and sorted best-first; `Array.prototype.sort` is stable, so **ties break by catalogue order** (the chooser display order, generic last).
- **`MIN_SCORE = 3`**: if the best NON-generic score is below 3, no specific template is a real match — the recommendation is **Generic Operations** (`generic_operations_v1`) with `confident: false`. Never a forced bad fit.
- **`MIN_LEAD = 2`**: if the top non-generic score leads the runner-up by less than 2, the result is **ambiguous** — the top template is still recommended but `confident: false`, and the UI emphasises the manual choice.

## 2. Manual override precedence (provider.ts `selectTemplate`)

**An explicit `intake.template_key` wins** — if the intake names a key that exists in the registry, that template is selected with reason "You selected this template yourself" and `confident: true`. The classifier still runs so the ranked alternatives are carried either way. A `template_key` NOT in the registry is ignored here (the classifier result is used) and would in any case be rejected by `validateProposal`'s registry-membership check.

## 3. What the proposal carries

`buildGroundedProposal` grounds the `ConfigProposal` on the selected template deterministically:

- **`template_key`** — the selected template.
- **`template_reason_en/ar`** — the honest why: the matched signals ("Your description matched this template's signals: fabrication, welding, ورشة…", first 5 keyword+phrase matches), the manual-choice sentence, or the generic-fallback explanation.
- **`template_alternatives`** — every OTHER ranked template with its score and bilingual name, so the preview can show the full comparison.
- **`template_confident`** — false on ambiguity or the generic fallback; the UI emphasises manual selection.
- **`artifacts`** — normally just an optional `terminology.overrides` artifact when the founder's job term differs from the template's own (so chosen words are APPLIED, not just echoed; English plural naively derived, Arabic plural editable later in Settings).
- **`approval_defaults`** — straight from intake; a value above the F-28 cap (2× the template default) is REJECTED by the validator, never silently clamped.
- **`requires_upgrade`** — requested features outside the always-on set are surfaced, never applied.
- **`intake_summary_en/ar`** — a human-readable restatement of what will be configured.

## 4. Honesty rules

- **Never a silent install.** The proposal is a PREVIEW; configuration is applied only after the founder's explicit Apply. The install itself is a sequence of undoable config revisions (see TEMPLATE_CONFIGURATION_REFERENCE.md).
- **Registry membership is validated.** `validateProposal` rejects a proposal whose `template_key` — or any alternative's key — is not a registered template: a bogus key fails at validation, never mid-apply.
- **An AI provider may only enrich prose.** The provider seam (`getOnboardingProvider`) ships the deterministic provider; a future AI provider may enrich the human-readable text and questions but **must emit the same validated `ConfigProposal` schema**, re-checked by `validateProposal` — it can never emit arbitrary configuration, change approval defaults beyond the F-28 cap, raise a role's cost/price privileges above the template baseline, or alter `requires_upgrade`.
- **Never claims unsupported capabilities.** Every catalogue entry carries a required, non-empty `limitations` list shown to the founder; advisory modules never grant entitlements; requested features outside the plan surface as `requires_upgrade`, never as applied config.
- **The evidence is shown.** The recommendation reason lists the actual matched signals; every alternative and its score is carried in the proposal.

## 5. Canonical classification examples

One representative phrase per template (all drawn from the entries' own `classificationPhrases`; each routes to its template with high confidence):

| Description | Recommended template |
|---|---|
| "we build fiberglass boats to order" | `boatbuilding_marine_v1` |
| "we run a steel fabrication workshop in dammam" | `manufacturing_workshop_v1` |
| "we run an ac maintenance company in dubai" | `service_business_v1` |
| "we are a fit-out contractor in dubai" | `construction_v1` |
| "we run a catering company in dubai" / "شركة تموين حفلات وأعراس" | `food_beverage_v1` |
| "we sell mobile phones and accessories online" | `online_store_v1` |
| "we run a vegetable farm in al ain" / "مزرعة أغنام وماعز في القصيم" | `agriculture_v1` |
| "we run a general services company in dubai" | `generic_operations_v1` (via fallback or its own signals) |

Arabic descriptions classify identically after folding — e.g. "مصنع قوارب في الإمارات" → boatbuilding, "ورشة تصنيع معادن ولحام في جدة" → manufacturing.

### Ambiguous and mixed descriptions

- **No real match** ("we import specialty chemicals", an empty description, a bare company name): best non-generic score < 3 → Generic Operations recommended, `confident: false`, with the explicit reason that no industry template clearly matched and the founder can pick any template below.
- **Mixed signals** ("we build boats and also do villa maintenance"): both marine and service templates score; if the lead is < 2 the result is marked ambiguous (`confident: false`) — the top match is still shown first, but the UI foregrounds the ranked alternatives and the manual chooser.
- **Ties**: broken deterministically by catalogue order (boatbuilding → manufacturing → service → construction → F&B → online store → agriculture → generic).
- In every case the founder can override via the manual chooser — `intake.template_key` always wins.
