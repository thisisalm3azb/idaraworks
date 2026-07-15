# DEFECT-3 — Supplier / Subcontractor (and Customer / Item) creation fix

**Status:** fixed and verified against the hosted Seoul DB.
**Scope:** master-data creation error handling for **suppliers, customers, items**.
**Owner-facing symptom:** adding a Supplier/Subcontractor showed *"Something went wrong — try again."* and the record was not added; the typed values were wiped.

---

## 1. The real root cause (with evidence)

The service layer was never the problem. Reproducing live against the hosted DB on a
**construction-template** org (`construction_v1` — the exact configuration the founder was on;
the supplier term renders as *"Supplier/Subcontractor"*), `createSupplier` **succeeds** across the
full input matrix:

```
term supplier singular="Supplier/Subcontractor" templateKey=construction_v1
[OK]   name only        [OK]   +tax        [OK]   +phone
[OK]   +email           [OK]   all fields  [OK]   arabic name
[FAIL] bad email → ZodError (invalid email) — the ONLY rejection
```

The failure lived entirely in the **server action wrapper**
(`src/app/(app)/o/[orgId]/suppliers/actions.ts`, and the identical customers/items wrappers):

```ts
try { await createSupplier(...); }
catch (err) {
  if (isRedirect(err)) throw err;
  redirect(`${base}?error=create_failed`);   // every error → one opaque code
}
```

Every error class — a mistyped email (a **ZodError**), a role without the capability
(**ForbiddenError**), a suspended org (**BillingReadOnlyError**), a genuine server fault —
collapsed into a single `?error=create_failed`. The page then rendered
`t("common.error")` = **"Something went wrong — try again."** — which is *verbatim* the founder's
report (and is distinct from the org error boundary, which reads *"This page hit a problem"*; so the
founder hit the **banner**, not the boundary). Two compounding defects:

1. **No diagnosis possible** — nothing was logged and no correlation id was surfaced, so the actual
   cause (almost certainly a mistyped email or an over-length field on the contact form) was invisible.
2. **Input was destroyed** — the POST-redirect dropped the body, so the form re-rendered empty and the
   founder had to retype everything, with no hint of what was wrong.

**Conclusion:** the deployed action *now provably succeeds* for a template-applied org; what the
founder hit was a recoverable, specific error (a bad email / invalid field) that the action buried
behind a dead-end generic message and a wiped form.

> Secondary UI note (coordinated — owned by another agent): the top-bar **"New"** quick-create menu is
> a `<details>` overlay (`z-30`, absolute) in `layout.tsx`. If left open it can sit over the top of the
> page. It is **not** the confirmed cause here (the banner text matches `?error=create_failed`, not the
> boundary), but it is being hardened separately (`docs/ux/QUICK_CREATE_MENU_FIX.md`).

---

## 2. The fix

### Shared helper — `src/platform/http/actionError.ts`

A single error path for all master-data creation actions:

- **classifies** the thrown error into a small, stable, safe code (never SQL/stack/secret/id);
- **logs the real error server-side** via the platform logger (`requestLogger`) bound to the request
  **correlation id** (`ctx.requestId`) + org/user ids — the logger already redacts phone/email keys;
- **redirects** back to the form with `?error=<code>&ref=<id>&field=<name>` **and the submitted values
  echoed**, so the page shows a specific message, a *"Reference: <id>"*, re-fills the form, and focuses
  the offending field;
- lets Next's `redirect()`/`notFound()` control-flow signals pass through untouched.

### Wired into all three creation actions

`suppliers/actions.ts`, `customers/actions.ts`, `items/actions.ts` now capture the submitted values up
front and, on failure, `return failMasterDataAction(err, { ctx, base, entity, values })`. Success is
unchanged: `revalidatePath(base)` + `redirect(base)` (the new row appears immediately — verified).

### Pages show the specific message + reference, and never wipe input

`suppliers/page.tsx`, `customers/page.tsx`, `items/page.tsx`:

- render the specific `masterdata.error.<code>` message + `masterdata.error.reference` (`Reference: <id>`)
  in a `role="alert"` banner (guarded by `isMasterDataErrorCode` so a hand-crafted `?error=` can't render
  a raw key marker);
- re-fill every `Field` via `defaultValue` from `searchParams` (progressive enhancement — no JS needed);
- mark the invalid field (`error` + `autoFocus`) so the cursor lands where the fix is needed.

### i18n (en + ar)

New keys added to **both** catalogs (`masterdata.error.*`) — catalog parity test stays green.

---

## 3. The error-handling model

| Code                | Trigger (error class)                                   | Field focused | Message (en) |
|---------------------|---------------------------------------------------------|---------------|--------------|
| `unauthorized`      | `ForbiddenError` (role lacks `catalog.manage` / `customers.manage`) | — | You do not have permission to add this. |
| `invalid_email`     | `ZodError` on the email field                           | `email`       | Enter a valid email address. |
| `name_required`     | `ZodError`, empty/missing `name`                        | `name`        | A name is required. |
| `invalid_input`     | any other `ZodError` (e.g. over-length, bad SKU/category) | first bad field | Some details are invalid — check the highlighted field. |
| `duplicate`         | Postgres `23505` unique violation (items: `org_id, sku`) | `sku` (items) | This already exists — check for a duplicate. |
| `read_only_billing` | `BillingReadOnlyError` (suspended/cancelled/purge org)  | —             | Your workspace is read-only while billing is paused — you can still view and export, but not add. Check your subscription. |
| `not_entitled`      | `CapabilityRequiredError` (add-on gate, e.g. `cap.items`) | —           | This needs an add-on to be enabled before you can add it. |
| `server_error`      | anything unrecognized (honest fallback)                 | —             | Something went wrong — try again. |

- **Correlation id:** every failure carries `ref=<ctx.requestId>` in the URL and in the server log line
  (`"master-data create failed"`), so a founder-reported reference maps straight to the log.
- **No leaks:** the client only ever sees `{ code, ref, field }` + its own echoed input — never a stack,
  SQL, secret, or internal id (asserted in tests).

### Duplicate-name policy (defined + tested)

- **Suppliers / Customers:** duplicate **display names are allowed by design** — there is no name
  uniqueness constraint (only `(id, org_id)` FK-pinning uniques). Two subcontractors may legitimately
  share a name. Tested: two suppliers with the same name both succeed.
- **Items:** **SKU is unique per org** (`item_org_sku_uq`). A duplicate SKU raises `23505` → mapped to
  `duplicate` on the `sku` field with a friendly message. Tested.

---

## 4. Master-data cases tested

**Unit** (`tests/unit/master-data-action-error.test.ts`, 13 tests): classifier for each error class
(bad email, missing name, other invalid field, forbidden, read-only billing, not-entitled, 23505
with/without sku constraint, nested `cause`, fallback); `isMasterDataErrorCode` guard;
`failMasterDataAction` logs with the correlation id and redirects with code + ref + field + preserved
values, re-throws Next redirects untouched, and leaks no internals.

**Integration — service matrix** (`tests/integration/r2fix-master-data-create.test.ts`, on a live
`construction_v1` org): supplier create name-only/+tax/+phone/+email/all-fields/Arabic/long(160);
bad email → `invalid_email`; over-length → `invalid_input`; viewer role blocked → `unauthorized`;
duplicate supplier names allowed; audit row written; tenant isolation; customer create + Arabic +
edit + retire (deactivate, **no hard delete**) + bad email + viewer blocked; item create with a
template category + duplicate SKU → `duplicate/sku` + viewer blocked; **suspended org** blocks the
write (`read_only_billing`) while the read still works (FR-9).

**Integration — action path** (`tests/integration/r2fix-supplier-action-path.test.ts`): drives the
**real `createSupplierAction`** on a template-applied org — SUCCESS creates the row and redirects to the
clean list URL; FAILURE (bad email) redirects with `error=invalid_email&field=email&ref=…` and the
submitted values preserved, with nothing written.

### Known gap (out of scope for this defect)

Only **customers** expose an edit/retire service surface (`updateCustomer`, `active:false`). **Suppliers
and items** currently ship **create + list only** in S1 — there is no `updateSupplier`/`updateItem` yet,
so "edit/retire" for those two is not implemented at the service or UI layer. Flagged for a follow-up;
this fix does not add those surfaces (it hardens the creation path the founder actually hit).
