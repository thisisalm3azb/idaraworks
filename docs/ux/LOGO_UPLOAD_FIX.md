# Logo upload fix (DEFECT 2 — onboarding logo upload fails in production)

Status: fixed. Root cause was a serverless function trace gap, compounded by a
generic error surface that hid the reason. This note records the root cause, the
fix, the pre-org asset ownership model, the format matrix, the error taxonomy
(codes → messages → correlation id) and every place the logo is rendered.

Cross-reference: `docs/ux/BRANDING_AND_LOGO.md` (the U2 branding surface) and
`docs/ux/ONBOARDING_FLOW.md` (the U4 wizard). PDF/document embedding is verified
elsewhere and is only listed here for completeness.

## 1. Root cause — sharp native libs missing from the `/onboarding` function trace

The image pipeline (`src/platform/files/image.ts`) uses **sharp**, whose native
binding depends on `@img/sharp-linux-x64` and `@img/sharp-libvips-linux-x64`.
On Vercel (Turbopack + pnpm) these native `.so` files are **not** picked up by
the default function trace, so `next.config.ts` force-includes them per route
via `outputFileTracingIncludes`.

Before the fix that list covered only two routes:

- `/api/inngest` — the image-derivatives worker (`processImage`)
- `/o/[orgId]/settings/branding` — settings logo upload (`uploadLogo → processLogo`)

The onboarding wizard's logo upload runs in a **different** serverless function —
the `(auth)/onboarding` route group, whose public path is **`/onboarding`** — and
that function was **not** in the list. So at runtime:

```
uploadFlowLogoAction (src/app/(auth)/onboarding/actions.ts)
  → stashDraftLogo    (src/modules/onboarding/draft.ts)
    → import("sharp")  → sharp.metadata()          ← ERR_DLOPEN_FAILED (libvips .so absent)
    → processLogo      (src/platform/files/image.ts)
```

The thrown `ERR_DLOPEN_FAILED` was caught and mapped to the generic
`{ error: "failed" }`, so the LogoPicker showed a bare "upload failed" — no code,
no reason, no correlation id.

The **confirm-time** upload runs in the same `/onboarding` function and would
have failed identically:

```
confirmFlowAction → runConfirmChain (src/modules/onboarding/service.ts)
  → applyDraftBranding (draft.ts) → uploadLogo (branding/service.ts) → processLogo
```

### Sharp-caller → route map (grep `processLogo|uploadLogo|processImage`)

| Caller | Route / function | Traced before | Traced after |
|---|---|---|---|
| `image-derivatives` worker (`processImage`) | `/api/inngest` | yes | yes |
| `uploadLogoAction → uploadLogo → processLogo` | `/o/[orgId]/settings/branding` | yes | yes |
| `uploadFlowLogoAction → stashDraftLogo → processLogo` | `/onboarding` | **no** | **yes** |
| `confirmFlowAction → …→ applyDraftBranding → uploadLogo → processLogo` | `/onboarding` | **no** | **yes** |
| `watermarkImage` (`src/platform/media/watermark.ts`) | not wired to any route yet | n/a | n/a |

## 2. The fix

### 2a. Root — trace the sharp libs to `/onboarding`

`next.config.ts` `outputFileTracingIncludes` gained a third key with the same two
globs. The route-group segment `(auth)` is stripped from the tracing key, exactly
as `(app)` is stripped for the existing `/o/[orgId]/settings/branding` entry:

```ts
"/onboarding": [
  "./node_modules/@img/sharp-linux-x64/**/*",
  "./node_modules/@img/sharp-libvips-linux-x64/**/*",
],
```

One key covers **both** onboarding sharp paths (the branding-step stash and the
confirm-time upload) because both run in the same `/onboarding` function.

### 2b. Robustness / error quality

- `uploadFlowLogoAction` (onboarding) and the three `settings/branding` actions
  now **distinguish** failure reasons: an expected `BrandingError` surfaces its
  own specific validation code; any **unexpected** server fault (e.g. the sharp
  dlopen) is logged server-side via the platform logger **with a correlation id**
  (`currentRequestId()` — the middleware-minted, server-trusted `x-request-id`)
  and returned as `{ error: "server_error", correlationId }`. The real error text
  is never leaked to the client.
- `LogoPicker` and `BrandingForm` render the specific message and, when present,
  a `Reference: <id>` line (monospace, `dir="ltr"`) the founder can quote. Both
  the click and drag-drop paths stay wired; a failed upload does **not** clear the
  other onboarding answers (the draft is server-side — see §3); success shows an
  immediate preview; replace/remove remain available; the stash persists across
  next/back/refresh because it lives in the draft row.

## 3. Pre-org onboarding-asset ownership model (verified — no change needed)

The wizard has no org and no storage bucket yet, so the branding step never
writes an object-storage file:

- **Stash (branding step).** `stashDraftLogo` validates (size → MIME whitelist →
  magic bytes → decoded dimensions), **re-encodes** through `processLogo`, and
  stores **only** the 512px PNG **base64** in the user-scoped `onboarding_draft`
  row (`data.branding.logo_base64`). It calls `saveDraft` only — **never**
  `objectStore().put`. Confirmed: no file row / storage object exists before the
  org does (integration test asserts zero `public.file` rows for the user after a
  stash).
- **Confirm.** `applyDraftBranding` (inside the idempotent `runConfirmChain`)
  re-validates and uploads via the real branding service (`uploadLogo`) into the
  **new** org's own tenant-media prefix, flips the file row `ready`, accounts the
  bytes and points `org_branding.logo_file_id` at it — all in one audited
  transaction.
- **User isolation.** `onboarding_draft` is USER-keyed with self-only RLS
  (migration 0073: policy keys on `app.current_user_id()`); another user can
  neither read nor write the stash. (Covered by `tests/integration/onboarding-draft.test.ts`.)
- **No orphan.** A cancelled/abandoned onboarding leaves only the user-scoped
  draft row (base64 in a jsonb column) — **no** storage object to orphan.
- **Idempotent confirm.** `runConfirmChain` claims the draft (status-guarded,
  stale-reclaimable), stashes each completed link, and returns
  `alreadyCompleted: true` for a duplicate submit — one org, one logo file row.

These properties were re-verified, not changed.

## 4. Formats tested (unit + integration)

Accepted: **PNG, transparent PNG (alpha preserved), JPG, WebP** — declared MIME on
the whitelist AND magic bytes agree AND decoded dimensions within 32–2000px.

Rejected, each with its specific code:

| Input | Code |
|---|---|
| SVG (declared `image/svg+xml`) | `bad_type` |
| Off-whitelist MIME (e.g. `image/gif`) | `bad_type` |
| Mismatched MIME vs signature (JPEG bytes as `image/png`) | `bad_signature` |
| Corrupt / non-image bytes | `bad_signature` |
| Renamed non-image (PDF header as `image/png`) | `bad_signature` |
| Zero-byte upload | `bad_signature` |
| Oversized (> 2 MB) | `too_large` |
| Tiny (< 32px edge) | `too_small_dims` |
| Huge (> 2000px edge) | `too_large_dims` |

Tests: `tests/unit/onboarding-logo.test.ts` (pure matrix + a real-PNG `processLogo`
sharp sanity check that asserts a PNG buffer out — the exact native path that fails
with a missing trace), plus the existing `tests/unit/branding.test.ts`. The
end-to-end stash→confirm→uploadLogo round-trip is
`tests/integration/onboarding-logo-roundtrip.test.ts`.

## 5. Error codes → messages → correlation id

Onboarding keys `onboarding.flow.branding.error.*`; settings keys `branding.error.*`
(both en + ar). The client maps the returned `error` code to the message; a
`correlationId` is present **only** for `server_error`.

| Code | When | Onboarding message (en) |
|---|---|---|
| `bad_type` | declared MIME off the whitelist (incl. SVG) | Use a PNG, JPG or WebP image. |
| `too_large` | file > 2 MB | The image is larger than 2 MB. |
| `bad_signature` | magic bytes missing / contradict the MIME | The file doesn't match its type — please export it again. |
| `too_small_dims` | edge < 32px | The image is too small — at least 32×32 pixels. |
| `too_large_dims` | edge > 2000px | The image is too large — at most 2000×2000 pixels. |
| `bad_image` | decode / re-encode failed | The image could not be read. Try a different file. |
| `quota_exceeded` | storage limit (confirm-time upload) | Storage limit reached. |
| `invalid_input` | no active draft / bad fields | The upload could not be saved. Please try again. |
| `session` | signed-out | Your sign-in expired. Please log in again. |
| `server_error` | **unexpected** fault (e.g. sharp dlopen) — logged w/ correlation id | Something went wrong on our side while processing the image. Please try again — your other answers are saved. |
| `failed` | last-resort generic | The upload failed. Please try again. |

On `server_error` the UI adds a second line — `Reference: <correlationId>` — that
matches the `request_id` on the server log line (`requestLogger(...).error(...)`),
so a founder's report can be traced without exposing the internal error.

The conceptual categories map onto these codes: unsupported_format → `bad_type`;
file_too_large → `too_large`; corrupt_image → `bad_image`/`bad_signature`;
dimensions_invalid → `too_small_dims`/`too_large_dims`; storage_unavailable →
`quota_exceeded`; server_error → `server_error`.

## 6. Where the logo appears (placements)

- **Onboarding branding step** — `LogoPicker` checkerboard preview
  (`src/app/(auth)/onboarding/LogoPicker.tsx`).
- **Onboarding review step** — summary thumbnail (`steps.tsx` ReviewStep).
- **Settings → Branding** — `BrandingForm` preview
  (`src/app/(app)/o/[orgId]/settings/branding/BrandingForm.tsx`).
- **In-app header** — `OrgLogo` in the org layout
  (`src/app/(app)/o/[orgId]/OrgLogo.tsx`, `layout.tsx`), gated by
  `feat.branding_app`; falls back to the initials avatar when off.
- **Documents** — quote, invoice and LPO/purchase-order renderers embed the logo
  as a data URI, gated by `feat.branding_docs` (verified elsewhere; listed for
  completeness).
