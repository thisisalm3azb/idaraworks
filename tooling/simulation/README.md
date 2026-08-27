# Business simulation factory (internal tool)

An **internal simulation / demonstration** tool that provisions five fictional
IdaraWorks organizations with coherent historical data, so the owner can log into
each one and evaluate the product across every workspace surface.

**This is not a customer template system and not part of the product runtime.** It
lives entirely under `tooling/` and is never imported by the app. Everything it
generates is fictional demonstration data — no real company, person, TRN, IBAN,
bank account, phone, address, or email inbox. Simulation performance is not a real
customer claim.

## The five businesses

| Scenario key     | Business (fictional)          | Template            | History | Language |
| ---------------- | ----------------------------- | ------------------- | ------- | -------- |
| `coffee_catering`| Finjan Coffee Catering        | food_beverage_v1    | ~4 mo   | English  |
| `shortstay_ops`  | Layali Stay Operations        | service_business_v1 | ~3 yr   | English  |
| `auto_workshop`  | TorqueLine Auto Workshop      | service_business_v1 | ~8 mo   | English  |
| `home_cupcakes`  | Sugar Petal Home Bakes        | food_beverage_v1    | ~3 mo   | English  |
| `palm_farm`      | بستان الرُطب للتمور (Date farm) | agriculture_v1      | ~2 yr   | Arabic (RTL) |

## How it is built

- **Pure, deterministic core** (`rng`, `money`, `dates`, `types`, `scenarios`,
  `plan`, `invariants`): a scenario + an explicit as-of date builds a byte-identical
  `Plan` from a fixed seed. Financial totals use the app's exact formulas so the
  seeded data reconciles with what the product computes. Unit-tested without a DB.
- **Effectful layer** (`provision`, `apply`, `cleanup`, `credentials`): writes the
  plan to the hosted database over the owner/superuser (`DIRECT_URL`) connection,
  idempotently (deterministic ids + `ON CONFLICT`). Owners are created via the
  Supabase **Admin API**, already email-confirmed — no verification email is sent.

## Safety

- **Marker-guarded.** Every org carries an `app_settings` `demo.simulation` marker.
  The factory and cleanup operate **only** on marked orgs and refuse unmarked ones.
- **Project-guarded.** Refuses to run against any Supabase project other than the
  expected one, and requires an explicit `--confirm` flag to write.
- **No external effects.** Writes rows directly; never runs the outbox relay, the
  invite flow, or any email/SMS/e-invoice/AI/billing provider.
- **Legitimate entitlement.** Each org is set to the real `internal_pilot` billing
  state on the `growth` plan (no faked payment-provider subscription).

## Usage

```
# validate only (no DB writes):
tsx tooling/scripts/sim-seed.ts --dry-run

# provision + seed the hosted project (writes real rows):
tsx tooling/scripts/sim-seed.ts --confirm

# list the demo orgs / tear them down (marker-guarded):
tsx tooling/scripts/sim-cleanup.ts
tsx tooling/scripts/sim-cleanup.ts --yes-really-delete-demo-orgs
```

Passwords and org/user ids are written to a **private file outside the repo**
(`…/Desktop/IdaraWorks Private/`) — never printed, logged, or committed. These are
temporary simulation credentials; rotate or delete them before any broader launch.
