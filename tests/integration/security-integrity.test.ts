/**
 * Security review 2026-09-20 (pass two) — financial integrity and the module
 * gate's data path, against the real database:
 *  - two concurrent payment requests with the SAME idempotency key record one
 *    payment and both answer with it; different keys record two (legitimate
 *    separate payments still work);
 *  - an expense and a bank voucher retried with the same key are replayed, not
 *    recorded twice;
 *  - the applied blueprint's "module switched off" state is what
 *    resolveCtxForAction refuses on: the shape read + the state function
 *    report a disabled module as disabled and every other module as active.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { getAppliedWorkspaceShape, moduleStateOf, disabledModulesOf } from "@/platform/workspace";
import { recordPayment } from "@/modules/payments/service";
import { createExpense, listExpenseCategories } from "@/modules/expenses/service";
import {
  installFinanceSetup,
  createBankAccount,
  recordMoneyTransaction,
} from "@/modules/finance/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
let categoryKey = "";
let bankId = "";
let cashId = "";

const A = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: `secint-${run}`,
});

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`secint-${run}@example.invalid`}, '{"full_name":"SecInt"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, {
    name: `SecInt ${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  await markFixtureOrg(owner, orgA, "secint", run);
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
  const cats = await listExpenseCategories(A());
  categoryKey = cats.find((c) => c.costingMapping === "overhead")?.key ?? cats[0]!.key;
  await installFinanceSetup(A(), "owner", { booksStartDate: "2026-01-01" });
  bankId = (
    await createBankAccount(A(), "owner", { name: "Main bank", kind: "bank", glCode: "1111" })
  ).id;
  cashId = (await createBankAccount(A(), "owner", { name: "Till", kind: "cash", glCode: "1101" }))
    .id;
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 240_000);

describe("payments (F-27)", () => {
  it("two concurrent requests with the same key record ONE payment and both answer with it", async () => {
    const key = `pmt-${randomUUID()}`;
    const input = {
      method: "cash",
      paymentDate: "2026-06-01",
      amountMinor: 12_345,
      currency: "AED",
      idempotencyKey: key,
    };
    const [a, b] = await Promise.all([
      recordPayment(A(), "owner", input),
      recordPayment(A(), "owner", input),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.reference).toBe(b.reference);
    const rows =
      await owner`select count(*)::int as n from public.payment where org_id = ${orgA} and idempotency_key = ${key}`;
    expect(rows[0]!.n).toBe(1);
  }, 60_000);

  it("two requests with different keys are two deliberate payments", async () => {
    const one = await recordPayment(A(), "owner", {
      method: "cash",
      paymentDate: "2026-06-02",
      amountMinor: 100,
      currency: "AED",
      idempotencyKey: `pmt-${randomUUID()}`,
    });
    const two = await recordPayment(A(), "owner", {
      method: "cash",
      paymentDate: "2026-06-02",
      amountMinor: 100,
      currency: "AED",
      idempotencyKey: `pmt-${randomUUID()}`,
    });
    expect(one.id).not.toBe(two.id);
  }, 60_000);
});

describe("expenses (F-27, 0143)", () => {
  it("a retried expense with the same key is replayed, not recorded twice", async () => {
    const key = `exp-${randomUUID()}`;
    const input = {
      categoryKey,
      description: "Office supplies",
      expenseDate: "2026-06-03",
      amountMinor: 5_000,
      vatAmountMinor: 250,
      idempotencyKey: key,
    };
    const first = await createExpense(A(), "owner", input);
    const second = await createExpense(A(), "owner", input);
    expect(second.id).toBe(first.id);
    expect(second.reference).toBe(first.reference);
    const rows =
      await owner`select count(*)::int as n from public.expense where org_id = ${orgA} and idempotency_key = ${key}`;
    expect(rows[0]!.n).toBe(1);
    // and exactly one cost posting for it
    const entries =
      await owner`select count(*)::int as n from public.journal_entry where org_id = ${orgA} and source_type = 'expense' and source_id = ${first.id} and event_key = 'recorded'`;
    expect(entries[0]!.n).toBe(1);
  }, 120_000);

  it("different keys record two expenses", async () => {
    const one = await createExpense(A(), "owner", {
      categoryKey,
      description: "A",
      expenseDate: "2026-06-03",
      amountMinor: 10,
      vatAmountMinor: 0,
      idempotencyKey: `exp-${randomUUID()}`,
    });
    const two = await createExpense(A(), "owner", {
      categoryKey,
      description: "B",
      expenseDate: "2026-06-03",
      amountMinor: 10,
      vatAmountMinor: 0,
      idempotencyKey: `exp-${randomUUID()}`,
    });
    expect(one.id).not.toBe(two.id);
  }, 120_000);
});

describe("bank vouchers (F-27)", () => {
  it("a retried voucher with the same key is replayed, not posted twice", async () => {
    const key = `mt-${randomUUID()}`;
    const input = {
      kind: "transfer",
      bankAccountId: bankId,
      counterBankAccountId: cashId,
      txnDate: "2026-06-04",
      amountMinor: 7_000,
      memo: "float",
      idempotencyKey: key,
    };
    const first = await recordMoneyTransaction(A(), "owner", input);
    const second = await recordMoneyTransaction(A(), "owner", input);
    expect(second.id).toBe(first.id);
    const rows =
      await owner`select count(*)::int as n from public.money_transaction where org_id = ${orgA} and idempotency_key = ${key}`;
    expect(rows[0]!.n).toBe(1);
  }, 120_000);
});

describe("the module gate's data path (F-21)", () => {
  it("an applied blueprint that switched a module off reports it disabled; every other module stays active", async () => {
    const cap = (key: string, on: boolean) => ({
      key,
      configEnabled: on,
      planEntitled: true,
      platformAvailable: true,
      effective: on,
      status: on ? "active" : "disabled_by_configuration",
      reason: {},
    });
    const compiled = {
      capabilities: [cap("cap.jobs", true), cap("cap.expenses", false), cap("cap.invoicing", true)],
      warnings: [],
    };
    await owner`
      insert into public.workspace_blueprint_revision
        (org_id, revision_no, status, schema_version, blueprint, blueprint_hash, compiled, compiler_version,
         proposed_source, created_by, applied_at)
      values (${orgA}, 1, 'applied', 1, '{}'::jsonb, ${"a".repeat(64)}, ${owner.json(compiled)}, '1.0.0',
              'user_change', ${userA}, now())`;
    const shape = await getAppliedWorkspaceShape(A());
    expect(shape).not.toBeNull();
    expect(moduleStateOf(shape, "cap.expenses")).toBe("disabled");
    expect(moduleStateOf(shape, "cap.jobs")).toBe("active");
    expect(moduleStateOf(shape, "cap.payments")).toBe("active"); // absent from the list = not switched off
    expect([...disabledModulesOf(shape!.compiled)]).toEqual(["cap.expenses"]);
    // A legacy organisation (no applied revision) passes through.
    expect(moduleStateOf(null, "cap.expenses")).toBe("no_blueprint");
  }, 60_000);
});
