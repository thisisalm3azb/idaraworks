# Self-Service Data Export — Operator Guide

**One-line rule:** a tenant can export its own core operational + financial data
as **CSV**, one entity at a time, through a **governed** path — tenant-scoped
(RLS second wall), **paged** (never the silent 1,000-row cap), **redaction-aware**
(money columns nulled for a caller who isn't cost/price-privileged), and
**formula-injection-safe** (every cell guarded). This is the data-portability +
account-closure prerequisite, and the surface you drive to answer a PDPL /
data-subject request. It is a **read** — it changes nothing.

Code: route `src/app/api/o/[orgId]/export/route.ts`, service
`src/platform/export/service.ts`, CSV guard `src/platform/export/csv.ts`, page
`src/app/(app)/o/[orgId]/settings/export/page.tsx` (S10, doc 10 #42).

---

## 1. The surfaces

- **UI:** `Settings → Export` (`/o/<orgId>/settings/export`). One **Download**
  link per entity; the link is a plain `GET` with `download`. Visible only to
  `data.export` holders (below) — the page redirects everyone else to `/o/<orgId>`.
- **API:** `GET /api/o/<orgId>/export?entity=<key>` → streams
  `text/csv; charset=utf-8` with `Content-Disposition: attachment;
  filename="<entity>.csv"` and `Cache-Control: no-store`.
  - `401 unauthorized` — no valid session/membership for the org.
  - `400 unknown entity` — bad/missing `entity`; the body lists the valid
    `available` keys.
  - `403 forbidden` — authenticated, but the caller lacks `data.export`.

**Access gate:** `data.export` → **owner / admin / accounts**
(`src/platform/authz/matrix.ts`). A **foreman / viewer cannot export at all**.

---

## 2. The entity catalogue (closed registry)

The exportable set is a **closed, ordered, enumerable** registry
(`EXPORT_ENTITIES` / `EXPORT_ENTITY_KEYS`) — deliberately, so the completeness
test can enumerate it (§6). Eight entities:

| `entity` key | Columns (CSV header order) | Money columns (redaction-gated) |
| --- | --- | --- |
| `jobs` | reference, name, status_category, current_stage, **selling_price_minor**, created_at | selling_price (price) |
| `customers` | name, tax_reg_no, contact_name, phone, email, created_at | — |
| `suppliers` | name, tax_reg_no, phone, email, created_at | — |
| `invoices` | reference, kind, status, customer_name, **total_minor**, **vat_amount_minor**, issued_at | total, vat (price) |
| `payments` | reference, status, method, customer_name, **amount_minor**, currency, payment_date | amount (price) |
| `expenses` | reference, category_key, description, **amount_minor**, expense_date, payment_status | amount (cost) |
| `daily_reports` | job_id, report_date, status, summary, created_at | — |
| `audit_log` | action, entity_type, entity_id, actor_user_id, summary, created_at | — |

Money is stored in **minor units** (integer). `audit_log` is the trail that
carries, among other things, the `support.impersonation_*` rows
([impersonation-history.md](impersonation-history.md)).

---

## 3. How the guarantees are enforced (what to trust)

- **Tenant isolation (two walls):** the route resolves the caller's context
  (`resolveCtx`) and every query runs inside `withCtx` — so RLS (`org_id =
  current_org_id()`) is a **second** wall behind the explicit `where org_id =
  ctx.orgId`. An export can only ever contain the caller's own org.
- **Paged, never truncated:** `exportEntityCsv` loops `offset += 1000` until a
  short page, so exports of unbounded-growth tables (reports, invoices, payments,
  expenses, audit_log) are **complete** — not silently capped at 1,000 rows.
- **Redaction wall (money):** `applyMoneyRedaction` **nulls** the money columns
  the caller isn't privileged to see, at this serialization boundary:
  - price columns (`jobs.selling_price`, `invoices.total`+`vat`,
    `payments.amount`) are nulled unless `ctx.pricePrivileged`;
  - cost columns (`expenses.amount`) are nulled unless `ctx.costPrivileged`.
  - **Why it matters:** `data.export` includes **accounts**, who is **not
    necessarily** cost/price-privileged (privilege is per the org's role config,
    read in `resolveCtx`). Holding the export action does **not** imply seeing the
    money — the wall is consulted independently. A non-money-privileged exporter
    gets full operational data with the money cells **empty**.
- **CSV formula-injection guard:** `csvEscape` (`csv.ts`) prefixes a single quote
  to any cell leading with `= + - @`, tab, or CR (so `=cmd|'/c calc'!A1` opens as
  text, not a formula), then RFC-4180-quotes every cell (doubling internal quotes)
  and joins with CRLF. Tenant-authored operational values (customer names, notes)
  never pass through the config sanitiser, so the export layer defends
  independently. This is safe to hand to a tenant to open in Excel/Sheets.

---

## 4. Running a PDPL / data-subject or cancellation export

**PDPL / data-subject / "give me my data" request.** The catalogue **is** the
portability bundle. Deliver every entity:

1. Confirm the requester is an **owner / admin / accounts** on the org (or is
   acting on that org's behalf) — `data.export` is the gate.
2. From `Settings → Export`, download each of the eight entities; or script the
   eight `GET /api/o/<orgId>/export?entity=<key>` pulls. The set is the full
   operational + financial + audit picture the platform holds for that org.
3. **Scope caveat — export is ORG-scoped, not person-scoped.** There is no
   per-individual filter; e.g. `customers`/`daily_reports` come whole. For a
   request about **one person**, export the relevant entity and **filter
   downstream**, and redact third-party personal data before handing it over as
   the legal situation requires. The export gives you the raw material, not a
   pre-scoped subject file.
4. Money visibility follows the exporter's privilege (§3). If the deliverable must
   include financial figures, run it as an owner (or a price-**and**-cost-
   privileged role); otherwise the money columns arrive empty **by design** — note
   that in the delivery so it isn't mistaken for missing data.

**Account closure / cancellation.** The same export is the **pre-purge bundle** a
tenant should take before their org is removed — data is never deleted out from
under them (FR-9: an over-limit or suspended org loses the ability to *add*, never
to *read or export*). Run the full eight-entity export **before** any purge step
and hand it to the tenant. (The governed org-closure/purge pipeline writes an
equivalent per-entity bundle to a closure prefix before purge; this manual export
is the operator-driven equivalent and the thing you can produce on demand today.)

> A read-only billing state (suspended / cancelled / purge_pending / purged) does
> **not** block export — `command()` blocks *mutations*, exports are reads. That
> is deliberate: a cancelled tenant must still be able to take its data out.

---

## 5. Doing it from the terminal (operator)

For scripted/bulk pulls or verification, hit the deployed route with the caller's
session cookie (exports are session-authenticated — there is no API key):

```bash
# <cookie> = the export-privileged user's Supabase auth cookie(s) for the app origin.
for e in jobs customers suppliers invoices payments expenses daily_reports audit_log; do
  curl -sS -b "<cookie>" \
    "https://idaraworks.vercel.app/api/o/<orgId>/export?entity=$e" \
    -o "<orgId>_$e.csv"
done
```

An unknown entity returns a `400` whose JSON body lists the valid `available`
keys — a cheap way to confirm the catalogue from prod without reading the source.

---

## 6. Completeness verification

The export is trustworthy only if **every** catalogued entity actually downloads
and **no** rows are silently dropped.

- **Catalogue enumeration (the shipped completeness test):** the S10 gate's
  **export column-probe (8/8)** enumerates `EXPORT_ENTITY_KEYS` and asserts each
  key produces a well-formed CSV with the expected header. To re-confirm on any
  environment, request every key from `?entity=` and check none returns `400`
  (i.e. the route's catalogue == the eight keys above). If you add an entity to
  `EXPORT_ENTITIES`, this probe and the catalogue table here must both grow.
- **Row-count completeness (spot-check against the DB):** because reads are paged,
  a full export should match the DB row count for that org. Read-only check
  (in-app export vs. a `begin transaction read only` `DIRECT_URL` count):
  ```sql
  select count(*) from public.invoice where org_id = '<org-uuid>';   -- vs. data rows in invoices.csv
  select count(*) from public.expense where org_id = '<org-uuid>';   -- vs. expenses.csv
  ```
  (CSV data rows = total lines − 1 header row.) A mismatch on a large table is the
  1,000-row-cap regression this design exists to prevent — treat it as a bug.

---

## 7. Redaction-wall verification

Confirm money never leaks to a caller who shouldn't see it:

- Export an entity that has money columns (e.g. `invoices` or `payments`) **as a
  role that holds `data.export` but is NOT price-privileged** (a typical
  `accounts` config, or an `admin` without cost privilege for `expenses`).
- The money columns (`total_minor`, `vat_amount_minor`, `amount_minor`, or
  `expenses.amount_minor`) must come out **empty**; the operational columns must
  still be populated.
- Re-export the same entity as an **owner** (price + cost privileged): the money
  columns are now filled. The delta is the wall working.

This is exactly the S10 production DoD assertion — the guarded CSV round-trip with
"amount **REDACTED** for a non-price-privileged reader"
(`tooling/scripts/s10-prod-demo.ts`, `docs/S10-HARDENING-COMPLETION.md`).

---

## 8. Known limitations (be honest with the tenant)

- **The export download is not itself audited.** The route is a pure read and
  does **not** go through the `command()` audit path, so downloading a CSV writes
  **no** `audit_log` row. If you need export accountability (who pulled what,
  when), capture it at the ops/infra layer (Vercel request logs, filtered by the
  `request_id` the response echoes) — do not assume the tenant audit trail records
  it. (The *contents* of `audit_log` are exportable; the act of exporting is not.)
- **Org-scoped, not subject-scoped** (§4) — no per-person filter.
- **Static catalogue** — only the eight entities above are exportable. Anything
  outside the registry (e.g. purchase orders, quotes, attendance) is not yet a
  self-service export target; request it be added to `EXPORT_ENTITIES` if a pilot
  needs it.
- **CSV only** — no XLSX/JSON variant from this surface.

---

## 9. Cross-references

- [impersonation-history.md](impersonation-history.md) — the `audit_log` export is
  how a tenant self-serves the support-impersonation trail.
- [access-revocation.md](access-revocation.md) / [break-glass.md](break-glass.md)
  — the `DIRECT_URL` read pattern used for the completeness spot-checks in §6.
- `src/platform/export/service.ts` (catalogue, paging, `applyMoneyRedaction`),
  `src/platform/export/csv.ts` (`csvEscape`, formula guard),
  `src/app/api/o/[orgId]/export/route.ts` (route + status codes),
  `src/app/(app)/o/[orgId]/settings/export/page.tsx` (the download page),
  `docs/S10-HARDENING-COMPLETION.md` (doc 10 #42 — the completion evidence) — the
  code this runbook drives.
