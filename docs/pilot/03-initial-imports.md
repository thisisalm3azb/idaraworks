# Initial imports — customers, employees, items

> How to bulk-load a pilot org's masters via the guided CSV importer, the exact
> column formats, how validation works, and the manual fallback. Companion to
> [`00-pilot-org-setup.md`](00-pilot-org-setup.md) and
> [`01-onboarding-template-checklist.md`](01-onboarding-template-checklist.md).

---

## What the importer is (and is not)

The guided importer (S8) covers three master kinds: **`customers`**, **`employees`**,
**`items`**. Each batch is **staged → per-row validated → applied**:

- Every row is validated against the **same Zod schema the manual form uses**, so an
  imported record gets the **identical validation, audit, and tenant (RLS) rules** as
  a hand-typed one.
- Apply runs through the governed masters services
  (`createCustomer` / `createEmployee` / `createItem`) — the importer has **no special
  write powers**.
- It is **re-runnable** and safe against double-submit (each row is claimed atomically
  before it's created, so two concurrent applies can't duplicate a record).
- It touches **nothing external** — no email, no files.

Suppliers are **not** in the guided importer; add suppliers via the manual form
(they're usually few).

---

## Who can import & where

- **Permission:** `imports.manage` — **owner / admin / manager**.
- **UI:** nav **Imports** → `/o/<orgId>/imports`.
- **Input method:** paste CSV text into the textarea and pick the kind. (It's a paste
  box, not a file picker — copy from your spreadsheet's CSV export.)
- **Batch size:** up to **5000 rows** per batch.

---

## CSV format

- First row is the **header**; each subsequent non-empty row is a record.
- Standard CSV quoting is supported (quoted fields, doubled `""` quotes, CR/LF).
- **Headers are forgiving** — common aliases map to the canonical field
  (case-insensitive, trimmed). Unknown columns are ignored. Empty cells are treated as
  "not provided".
- **Money is in MINOR units** (integer): AED/SAR/QAR/USD/EUR × 100, KWD/BHD/OMR × 1000.
  Example: `5,000.00 AED` → `500000`.

### `customers`

| Canonical field | Accepted headers | Rules |
| --- | --- | --- |
| `name` | `name`, `customer name` | **required**, 1–160 chars |
| `country` | `country` | optional, ISO-2 uppercase (e.g. `AE`) |
| `contactName` | `contact name`, `contact` | optional |
| `phone` | `phone` | optional |
| `email` | `email` | optional, valid email (blank allowed) |
| `taxRegNo` | `tax reg no`, `trn` | optional |
| `notes` | `notes` | optional |

Example:

```csv
name,country,contact,phone,email,trn
Marina Holdings LLC,AE,Sara Al Amiri,+9715...,ops@marina.ae,100123456700003
```

### `employees`

| Canonical field | Accepted headers | Rules |
| --- | --- | --- |
| `name` | `name`, `employee name` | **required**, 1–120 chars |
| `phone` | `phone` | optional |

Example:

```csv
name,phone
Ahmed Hassan,+9715...
Ravi Kumar,
```

> **Employees are not users.** Importing an employee creates a **labour resource**
> (for attendance, labour costing, HR docs) — **no login, no seat consumed, no
> invite sent**. Salary/HR side-records and linking an employee to a login user are
> separate privileged actions done later; they are **not** part of the import.

### `items`

| Canonical field | Accepted headers | Rules |
| --- | --- | --- |
| `sku` | `sku` | **required**, 1–64 chars |
| `name` | `name`, `item name` | **required**, 1–160 chars |
| `categoryKey` | `category`, `category key` | **required**, must be an **existing, non-retired item category** (lowercase key) |
| `unit` | `unit`, `uom` | **required**, 1–16 chars |
| `unitCostMinor` | `unit cost`, `unit cost minor` | optional, integer minor units (**cost-walled**) |
| `sellingPriceMinor` | `selling price` | optional, integer minor units (**price-walled**) |
| `minQty` | `min qty` | optional, number |

Example (marine categories from template #1 — e.g. `fiberglass`, `resin`, `hardware`,
`electrical`, `motors`):

```csv
sku,name,category,unit,unit cost,selling price
FG-450,Fiberglass mat 450g,fiberglass,roll,12000,
RES-VE,Vinylester resin,resin,kg,3500,
```

> **Item categories must exist first.** They come from installing template #1
> (§2 of doc 00). A row whose `category` isn't an active category is **rejected** with
> a clear per-row error. Configure/verify categories before importing items.

---

## The staging → apply cycle

1. **Stage** — pick the kind, paste CSV, submit. The importer parses, maps aliases,
   validates each row, and creates an `import_batch` with per-row `valid` / `invalid`
   status. You're redirected to the batch review.
2. **Review** — the batch shows counts (**valid / invalid / applied**) and a per-row
   list. Invalid rows show the **first few validation errors inline**
   (e.g. `name: Required`, `categoryKey: unknown or retired item category "foo"`).
3. **Fix invalid rows** — correct them in your source CSV and **re-stage** (a new
   batch), or just re-stage the whole file — only valid, not-yet-applied rows are ever
   created, so re-running is safe.
4. **Apply** — click **Apply (N)** to create the valid rows through the governed
   services. Each created record is a normal audited masters row. If a specific row
   fails at create time, it flips back to `invalid` with the error; the rest still
   apply.

**Money redaction on review:** because `imports.manage` is held by a (non-cost/-price
privileged) manager, staged **item unit cost / selling price are hidden** from a
manager viewing the review — the values still apply correctly, they're just not shown
to someone without the money privilege (F-23).

---

## Manual fallback (per-entity forms)

Use these for a few records, for suppliers (no importer), or to add one after an
import. All are the same governed services the importer calls.

| Entity | Nav / URL | Permission |
| --- | --- | --- |
| Customers | `/o/<orgId>/customers` | `customers.manage` (owner/admin/manager) |
| Suppliers | `/o/<orgId>/suppliers` | `catalog.manage` (owner/admin/manager/procurement) |
| Employees | `/o/<orgId>/people` | `employees.manage` (owner/admin/manager) |
| Items | `/o/<orgId>/items` | `catalog.manage` (owner/admin/manager/procurement) |

Manual forms also expose fields the importer does not — e.g. supplier terms, team
assignment, and the privileged employee **salary terms** / **HR documents** (owner/
admin only, behind the cost/HR walls).

---

## Verify the import

- **On the batch:** valid = applied, invalid = 0 (after fixes).
- **On the list page:** the new records appear (Customers / People / Items).
- **Round-trip export** (proves the data is really there and tenant-scoped):
  - `GET /api/o/<orgId>/export?entity=customers`
  - `GET /api/o/<orgId>/export?entity=jobs` (later, once jobs exist)
  - Money columns are redacted to the caller's cost/price privilege; the CSV is
    formula-injection-safe.

---

## Recommended pilot import order

1. Confirm **item categories** exist (from template #1).
2. Import **customers**.
3. Import **employees**.
4. Add **suppliers** (manual form).
5. Import **items** (needs categories).
6. Spot-check each list page; export one entity to confirm.

No owner-provisioned credentials are required to import — being owner/admin/manager
is enough. (Email and storage are not involved in imports.)
