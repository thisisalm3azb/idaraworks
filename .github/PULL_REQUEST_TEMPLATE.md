# PR

## What & why

<!-- One paragraph. Which operational loop step does this serve? Cite spec sections (e.g. phase2/05 D-5.1). -->

## Spec references

- Spec:
- phase2/10 checklist items touched:
- Spec divergence found? (fixed in code / doc amendment PR / n/a):

## Engineering review checklist (BUILD_BIBLE §18 — complete honestly; AI-authored PRs identically)

- [ ] 1. Serves a named loop step (or platform substrate) — stated above
- [ ] 2. Tenancy: RLS + bleed seeds for new tables · no raw client · no client-supplied org · by-id ownership checks
- [ ] 3. Authz: `can()` on new endpoints · redaction at new serialization points · matrix runner extended
- [ ] 4. Money: golden files updated · VAT recorded-not-assumed · bigint minor units · void semantics
- [ ] 5. Derived data computed by its single owner
- [ ] 6. Registries: closed enums only extended in `registries.ts`
- [ ] 7. Idempotency/concurrency handled where two-users-at-once applies
- [ ] 8. i18n/RTL: strings via `t()` · terminology variables · logical CSS · formatters for numbers/dates
- [ ] 9. Typed errors · no PII in logs · request_id flows
- [ ] 10. Perf: paging on lists · SQL aggregates · indexes + EXPLAIN for hot queries
- [ ] 11. Files via storage helper with correct access class · thumbnails on list surfaces
- [ ] 12. AI: closed payloads · validators · fallback · metering
- [ ] 13. Tests: failing-first regression for bug fixes · no skips without issue+date
- [ ] 14. Docs honest; N/A items marked N/A with a word of why

> Labels: add `ai-authored` if applicable; `security-review` if §6.14 areas are touched.
