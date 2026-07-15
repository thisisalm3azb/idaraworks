# Organization Branding & Logo (U2)

One governed source of branding truth per organization, rendered across the app
and printed documents, honestly gated by the two branding add-ons.

## Architecture — one governed source

- **Table:** `org_branding` (migration `0071_org_branding.sql`) — one row per
  org: `logo_file_id` (nullable FK to the `file` table), `accent_color`
  (`CHECK ^#[0-9a-fA-F]{6}$`), `display_name`, `legal_name`, `footer_details`,
  `updated_at`. Tenant RLS (`org_id = app.current_org_id()` for read AND
  write); grants are `select, insert, update` only — **no DELETE** (the
  no-hard-delete law; branding is cleared by nulling columns). Registered in
  the two-org bleed harness via a seeder in
  `tooling/scripts/seed-two-orgs.ts` (the harness auto-discovers `org_id`
  tables and fails without one).
- **Service:** `src/modules/branding/service.ts` — `getBranding` (null-safe
  defaults), `saveBranding` (gated by `config.manage`, audited via
  `command()`), `uploadLogo` / `removeLogo`, and the two **display reads**
  `getAppBranding` / `getDocBranding` (the enforcement call sites — see
  Gating).
- **Logo storage:** the logo is a normal file-pipeline row —
  `access_class job_media` (readable by every member, tenant-media bucket),
  attached to `('org', <org_id>)`, path built by `paths.ts`
  (`<org>/job_media/org/<org>/<file_id>[.thumb].png` — safe generated names).
  Bytes are **re-encoded server-side** through the platform image pipeline
  (`processLogo` in `src/platform/files/image.ts`: sharp, EXIF orientation
  applied then all metadata dropped, PNG output so transparency survives,
  512px main + 128px thumb). The uploaded bytes are **never stored as-is**
  (VC-4). The row is inserted `ready` with its variants, bytes accounted on
  `org_storage_usage` and quota-checked, and `org_branding.logo_file_id`
  updated — all in ONE audited transaction.
- **Serving:** in-app reads go through the existing authenticated signed-read
  path (`signRead` — file-table RLS + storage RLS as the requesting user,
  short TTL). Documents embed the logo **as a data URI at render time**,
  fetched from tenant-scoped storage by `getDocBranding`. The logo is never
  publicly writable and never readable cross-tenant (RLS scopes the file-row
  read; a foreign file id resolves to nothing).

## Placements and their gating feature keys

| Placement                                   | Feature key          | Add-on                | Fallback when off              |
| ------------------------------------------- | -------------------- | --------------------- | ------------------------------ |
| App header brand slot (`OrgLogo` component) | `feat.branding_app`  | `addon.branding_app`  | `<OrgAvatar>` initials         |
| Dashboard placements (consume `OrgLogo`)    | `feat.branding_app`  | `addon.branding_app`  | `<OrgAvatar>` initials         |
| LPO print template                          | `feat.branding_docs` | `addon.branding_docs` | Org-name text header           |
| Quote print template (`quote-template.ts`)  | `feat.branding_docs` | `addon.branding_docs` | Org-name text header           |
| Invoice print template                      | `feat.branding_docs` | `addon.branding_docs` | Org-name text header           |

Gates are **display-level**: service reads never throw on a missing
capability — they return the honest fallback shape. During the growth trial
both features resolve `true` (the paid tiers enable every feature key), so new
users see their logo everywhere immediately. The settings page shows a short
honest note naming exactly which placements are locked and their price.

Reusable components: `<OrgAvatar>` (`src/platform/ui/OrgAvatar.tsx`, pure
initials avatar, accent-colour aware) and `<OrgLogo>`
(`src/modules/branding/OrgLogo.tsx`, server component: gate + sign + render,
never throws). The dashboard-redesign work should consume `<OrgLogo>`.

## Upload validation matrix (`src/modules/branding/validation.ts`)

Order: size → declared-MIME whitelist → magic bytes → decode → dimensions →
re-encode. Unit-tested as a matrix in `tests/unit/branding.test.ts`.

| Check           | Rule                                                       | Error code       |
| --------------- | ---------------------------------------------------------- | ---------------- |
| Size            | ≤ 2 MB (`LOGO_MAX_BYTES`)                                  | `too_large`      |
| MIME whitelist  | `image/png`, `image/jpeg`, `image/webp` — **SVG rejected** | `bad_type`       |
| File signature  | Magic bytes must exist AND agree with the declared MIME    | `bad_signature`  |
| Decodability    | sharp must decode it (`failOn: "error"`)                   | `bad_image`      |
| Dimensions      | ≥ 32×32, ≤ 2000×2000 px                                    | `too_small_dims` / `too_large_dims` |
| Quota           | Storage quota respected (adds blocked at 100%, FR-9 reads never) | `quota_exceeded` |

SVG is rejected outright (never on the whitelist, never sniffed): it is a
script-capable document format, not a bitmap.

## PDF behaviour

- Templates are **pure functions** taking explicit branding args
  (`logoDataUri`, `footerDetails`, branded `orgName`) — a render for org A can
  never embed org B's data by construction (unit-tested).
- The logo `<img>` is contained (`max-height: 64px; max-width: 180px;
  object-fit: contain`, aspect preserved); every interpolation is
  HTML-escaped (§6.11); bidi discipline mirrors the LPO template (RTL primary,
  Latin tokens isolated).
- `footer_details` prints as a centred pre-line block above the reference
  footer.
- Render seams: `buildLpoHtmlForPo` (existing), `buildQuoteHtmlForQuote`
  (new), `buildInvoiceHtmlInternal` (existing) each call `getDocBranding`
  before rendering. Worker registration mirrors `lpo-pdf.ts`:
  `quote-pdf.ts` (`quote-pdf-renderer` on `quote/accepted`) joins
  `lpoPdfRenderer` / `invoiceOnIssued` in `src/workers/index.ts`. The
  HTML→PDF render+store runtime remains the same gated seam as before (owner
  action) — no new worker plumbing.

## Fallbacks

- No logo uploaded, feature off, signing failure, storage hiccup, or a voided
  file → in-app: initials avatar; documents: org-name text header. A branding
  failure can never break a page or a document render (logged at warn).

## Catalogue honesty note

Migration `0070` reclassified `addon.branding_docs` / `addon.branding_app` to
**deferred** because no branding capability existed — selling them was
dishonest. Migration `0071` reverses that **WITH enforcement**: the capability
now ships, both add-ons return as `available` at the owner's $2/$1 anchors
(fresh v2 active price rows — the 0070-deactivated v1 rows stay inactive;
prices are versioned, never reactivated; `is_placeholder = true` pending owner
ratification), and their feature keys have real `hasFeature` call sites in
`src/modules/branding/service.ts` (pinned by
`tests/unit/addon-enforcement-parity.test.ts`). `addon.exports_extended`
remains deferred — nothing changed there. 0070's bundle removals are NOT
reversed by 0071 (re-adding branding to bundles is a commercial decision).
