# Homepage launch QA (H10)

Date: 2026-08-28. Audit performed against the production build of the H10 tree
(the audited baseline was production commit `3abbb24`, H9; the H10 corrections
below ship in the H10 commit). Production origin: `https://www.idaraworks.com`.

## 1. Audited production commits

- Baseline audited: `3abbb24` (H9) on https://www.idaraworks.com (health-verified).
- Corrections committed as H10 (this commit; hash recorded in git history).

## 2. Routes tested (production, custom domain)

| Route | Result |
| --- | --- |
| `/` | 200, serves the full homepage |
| `/#how` `/#product` `/#international` `/#trust` `/#pricing` | anchors exist with `scroll-mt-16` sticky offset (DOM-verified) |
| `/signup` (Get Started) | 200 |
| `/login` | 200 |
| `/terms` | 200 |
| `/privacy` | 200 |
| `/robots.txt` | 200; disallows `/o/`, `/account`, `/onboarding`, `/mfa`, `/invite/`, `/reset-password`, `/s/`, `/api/`, `/auth/` |
| `/sitemap.xml` | 200 |
| `https://idaraworks.com/` (apex) | 308 → `https://www.idaraworks.com/` |
| localhost references in served HTML | 0 |

Signed-out CTA: Get Started → `/signup`, Log in → `/login` (unit-pinned in
`home-page.test.ts`). Signed-in primary → resolved workspace, no login action
(unit-pinned). Unsafe `next` inputs cannot create an open redirect
(`auth-callback.test.ts` sanitization suite). Signed-in production behavior was
not exercised with a live session in this audit (no credentials used); the
routing contract is unit-covered.

## 3. Viewports tested

English and Arabic, each at 1440 / 1280 / 1024 / 768 / 430 / 390 / 375 / 360 /
320 px against the production build: **horizontal overflow = 0 at all 18
states** (after the fix in §15). Reduced motion verified per section (H3.3B,
H4-H9 are static or render the finished state). 200% zoom behavior is
equivalent to the ≤768px matrix (layout reflows; no horizontal scroll).
Forced-colors and increased-text-size tooling was not available in this
environment and was not verified. No-JS: the homepage is server-rendered
static markup (the mobile menu is the one client island); all copy, sections
and links are present without JavaScript.

## 4. English results

All sections render correctly at every tested width; labels readable, no
clipping or overlap found in the captured matrix (scratchpad H8-H10 shots).

## 5. Arabic and RTL results

Full mirror at every width, natural product terminology reused across
sections, the Business Passport's English surface correctly stays LTR inside
the RTL page, directional glyphs (converge, undo, forward) flip explicitly.
One defect found and fixed (§15: RTL hero pulse overflow at 1024). All new
Arabic strings across H4-H9 remain flagged for professional native review.

## 6. Accessibility results

- One `h1`; 7 `h2` sections; `h3` only inside sections (verified live).
- Landmarks: banner, one labelled nav, `main#main` (focusable target),
  contentinfo footer with labelled nav.
- All decorative visuals `aria-hidden`; each hero visual is one labelled
  `role="img"`; no color-only status anywhere (text labels carry
  Available/Planned and all states).
- No positive `tabindex` on the page (verified live: 0).
- Contrast: token palette (ink on page/card) is AA for body text by design;
  no automated axe run was performed (no such dependency in the repo).

## 7. Keyboard results (production build, Chromium)

1. First Tab reveals the skip link ("Skip to main content", ≥44px, visible). ✓
2. Header order: brand → How it works → Product → International → Pricing →
   language switch → Log in → Get Started. ✓
3. Mobile menu: opens by keyboard, traps focus, Escape closes and restores
   focus (pure-function suite + source wiring tests; H2 production check).
4. Focus ring visible on pricing/CTA links (`:focus-visible` outline). ✓
5. Anchors all resolve (`#how #product #international #trust #pricing #main`). ✓
6. No keyboard trap outside the open mobile menu. ✓

## 8. Routing results

See §2. All green. No stale Vercel-domain redirect; apex 308s to www.

## 9. Metadata and SEO results

Defect found: canonical URL, Open Graph URL, robots host/sitemap and sitemap
entries all pointed at `https://idaraworks.vercel.app`. **Fixed** to
`https://www.idaraworks.com` (page metadata, `robots.ts`, `sitemap.ts`), and
the auth-callback production fallback origin was updated the same way (a
narrow constant change; APP_URL still wins when set). Title, description,
OG title/description/locale, twitter card, `lang`/`dir` per locale verified
live. No structured data is used (none warranted yet); no invented
organization details. Favicon served by the app layout.

## 10. Performance observations

- The homepage is a server component; the only client islands are the mobile
  menu and language switch. No animation library; the one animated section
  (hero) uses run-once CSS under motion-safe.
- No third-party requests from the homepage (CSP-constrained; fonts are
  self-hosted via next/font).
- Console errors at all 18 viewport states: none. The `?_rsc=` request
  failures observed during automated capture are Next.js prefetches aborted
  by page teardown, not user-facing errors.
- No raster assets on the page; all visuals are DOM/SVG (small payload).
- No evidence-backed performance defect found; no change made.

## 11. Security and truthfulness review

H8's Trust section claims map 1:1 to implementation (RLS-bounded workspaces,
authz matrix, server-side money redaction incl. exports, config revisions
with undo, configuration guardrail) and `trust-boundary.test.ts` bans
certification/uptime/encryption/breach claims and internal identifiers.
Export, capability, international, and configuration claims remain pinned to
audited inventories by the H4-H7 suites. No fake consent, support, or
contact controls exist anywhere on the page.

## 12. Pricing truthfulness review

Plans map to real catalogue tiers (names read from the catalogue), no numeric
price/discount/trial/unlimited claims (test-banned), per-plan "Launch pricing
is being finalized", and the payment statement matches the gated provider
("No charge is taken while you set up your workspace"). The unverifiable
"Prices are shown at sign-up" line was retired in H9.

## 13. Legal-link results

`/terms` and `/privacy` resolve (200) and are linked from the Trust section
and the footer. Public copy does not present itself as legal advice.

## 14. Browser coverage

Chromium only (Playwright chromium is the only engine installed in this
environment). Firefox and WebKit were NOT verified; this is an honest
limitation. Standards-based fallbacks exist: the page is static server markup
except the hero (whose `offset-distance` pulse simply never appears on
engines without support, leaving the static state intact), and CSS uses
widely-supported logical properties and color-mix.

## 15. Defects found and corrected in H10

1. **RTL horizontal overflow at 1024px (pre-existing since H3.3B):** the
   hero's motion-only pulse dot (opacity-0, `offset-path`-positioned) escaped
   the mirrored wrapper and extended the scroll width by 19px on the Arabic
   page. Fixed by clipping the wrapper (`overflow-hidden`); overflow is now 0
   at all 18 locale x width states. Regression-pinned in
   `homepage-launch.test.ts`.
2. **Stale canonical origin:** page canonical/OG URL, robots host+sitemap,
   sitemap entries, and the auth-callback production fallback pointed at the
   Vercel domain. All now use `https://www.idaraworks.com`;
   regression-pinned.

No other defect met the correction bar; H1-H9 presentation was left unchanged.

## 16. Known limitations

- Chromium-only visual/keyboard verification (no Firefox/WebKit here).
- No automated axe/contrast run (no such dependency; not added for H10).
- Forced-colors / increased-text-size not verified (tooling unavailable).
- Signed-in production CTA not exercised with a live session in this audit.
- Em dashes remain in ~200 authenticated-surface catalog strings (auth,
  onboarding, subscription, branding namespaces). The public homepage
  namespaces are clean and test-pinned; the authenticated copy sweep is a
  separate decision.
- All new Arabic homepage strings (H4-H9) still need professional native
  review before marketing push.

## 17. Owner actions before launch

1. Confirm the Vercel env var `APP_URL` is set to
   `https://www.idaraworks.com` in production (the code fallback now matches,
   but the env var should be explicit).
2. Confirm the Supabase auth Site URL / redirect allow-list includes
   `https://www.idaraworks.com` (owner dashboard action; pairs with the
   existing owner-action checklist).
3. Commission the professional native Arabic review of the homepage copy.
4. Ratify launch pricing when ready (placeholder price book is deliberately
   not public).
5. Optional: decide on the authenticated-surface em-dash copy sweep.

## 18. Launch status

**Ready with owner actions.** No launch blocker remains in the code: routes,
anchors, CTAs, legal links, metadata, responsiveness (0 overflow across the
matrix), accessibility pass, and truthfulness contracts are green on the
final tree. The items in §17 are configuration/review actions outside the
repository.
