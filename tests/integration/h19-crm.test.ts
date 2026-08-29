/**
 * H19 — Customer 360 against the real database: the 360 aggregation with
 * quote/work/invoice/receivable links, outstanding-balance parity with the
 * shared derivation, customer-filter count parity across destinations,
 * cross-organization denial, restricted redaction, create-quotation-from-
 * customer with server-side association, accepted quotation creating work
 * that carries BOTH the customer and the blueprint stages, timeline
 * authorization per role, archive with linked records, possible-duplicate
 * detection, and the normalized-contact model with the legacy adapter.
 * Self-cleaning (wipeOrgs).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate } from "@/platform/config/install";
import {
  createBlueprintDraft,
  validateBlueprintRevision,
  approveBlueprintRevision,
  applyBlueprintRevision,
} from "@/platform/workspace";
import {
  addCustomerContact,
  createCustomer,
  findPossibleDuplicates,
  listCustomerContacts,
  setCustomerActive,
} from "@/modules/masters/service";
import { createQuote, acceptQuote, listQuotes } from "@/modules/quotes/service";
import { listActivePresets, listJobs } from "@/modules/jobs/service";
import {
  createInvoice,
  issueInvoice,
  computeAR,
  customerMoney,
  customerOutstandingMap,
  listInvoices,
  listOutstandingInvoices,
} from "@/modules/invoices/service";
import { gatherCustomer360, listCustomerTimeline } from "@/modules/crm/service";
import { orgToday } from "@/modules/dashboard/service";
import { scenarioContractor } from "../unit/workspace-fixtures";
import { ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";
let presetA = "";
let custId = "";

const ctxOf = (orgId: string, userId: string, priv = true): Ctx => ({
  orgId,
  userId,
  costPrivileged: priv,
  pricePrivileged: priv,
  requestId: "h19-test",
});

const asOf = orgToday(new Date(), "Asia/Dubai");
const FIXTURE_STAGES = scenarioContractor().workflows[0]!.stages;

async function seedUser(id: string, label: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h19-${label}-${run}@example.com`}, '{"full_name":"H19 Test"}'::jsonb, now(), now())`;
}

beforeAll(async () => {
  await seedUser(userA, "a");
  await seedUser(userB, "b");
  orgA = await createOrgForUser(userA, { name: "H19 A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "H19 B", country: "AE", baseCurrency: "AED" });
  await installTemplate(ctxOf(orgA, userA), "generic_operations_v1");
  const draft = await createBlueprintDraft(ctxOf(orgA, userA), "owner", {
    blueprint: scenarioContractor(),
    source: "onboarding_answer",
    reason: "H19 crm test",
  });
  await validateBlueprintRevision(ctxOf(orgA, userA), "owner", draft.id);
  await approveBlueprintRevision(ctxOf(orgA, userA), "owner", draft.id, {
    expectedHash: draft.blueprintHash,
  });
  await applyBlueprintRevision(ctxOf(orgA, userA), "owner", draft.id);
  presetA = (await listActivePresets(ctxOf(orgA, userA), "owner"))[0]!.id;
  ({ id: custId } = await createCustomer(ctxOf(orgA, userA), "owner", {
    name: "Marina Holdings",
    email: "accounts@marina.example",
    phone: "+971 4 555 0100",
    contactName: "Huda",
  }));
}, 180_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end({ timeout: 5 });
  await closeAppDb();
}, 120_000);

describe("H19 — quote from customer → work with blueprint stages", () => {
  let quoteId = "";
  let jobId = "";

  it("creates a quotation with a server-validated customer association", async () => {
    const q = await createQuote(ctxOf(orgA, userA), "owner", {
      customerId: custId,
      presetId: presetA,
      lines: [{ description: "Fit-out phase one", qty: 1, unit: "lot", unitPriceMinor: 500000 }],
    });
    quoteId = q.id;
    const listed = await listQuotes(ctxOf(orgA, userA), "owner", { customerId: custId });
    expect(listed.some((r) => r.id === quoteId)).toBe(true);
  });

  it("a foreign customer id is rejected without existence disclosure", async () => {
    const foreign = await createCustomer(ctxOf(orgB, userB), "owner", { name: "B Corp" });
    await expect(
      createQuote(ctxOf(orgA, userA), "owner", {
        customerId: foreign.id,
        lines: [{ description: "x", qty: 1, unit: "lot", unitPriceMinor: 100 }],
      }),
    ).rejects.toThrow(/customer not found/);
    await expect(
      createQuote(ctxOf(orgA, userA), "owner", {
        customerId: randomUUID(),
        lines: [{ description: "x", qty: 1, unit: "lot", unitPriceMinor: 100 }],
      }),
    ).rejects.toThrow(/customer not found/); // identical error either way
  });

  it("acceptance creates work carrying the customer AND the approved stages", async () => {
    await owner`update public.quote set status = 'sent', updated_at = now()
                where id = ${quoteId} and org_id = ${orgA}`;
    ({ jobId } = await acceptQuote(ctxOf(orgA, userA), "owner", quoteId, {
      jobName: "Marina fit-out",
    }));
    const job = (await owner`
      select customer_id::text as customer_id from public.job where id = ${jobId}`) as unknown as Array<{
      customer_id: string;
    }>;
    expect(job[0]!.customer_id).toBe(custId);
    const stages = (await owner`
      select stage_key from public.job_stage where job_id = ${jobId} order by sort`) as unknown as Array<{
      stage_key: string;
    }>;
    expect(stages.map((s) => s.stage_key)).toEqual(FIXTURE_STAGES.map((s) => s.key));
  });

  it("customer-filter count parity across quotes, jobs and invoices", async () => {
    const { id: invId } = await createInvoice(ctxOf(orgA, userA), "owner", {
      customerId: custId,
      jobId,
      dueDate: asOf,
      lines: [{ description: "Milestone 1", qty: 1, unit: "lot", unitPriceMinor: 250000 }],
    });
    await issueInvoice(ctxOf(orgA, userA), "owner", invId);
    const ctx = ctxOf(orgA, userA);
    const [quotes, jobs, invoices] = await Promise.all([
      listQuotes(ctx, "owner", { customerId: custId }),
      listJobs(ctx, "owner", { customerId: custId }),
      listInvoices(ctx, "owner", { customerId: custId }),
    ]);
    const counts = (await owner`
      select
        (select count(*)::int from public.quote where org_id = ${orgA} and customer_id = ${custId}) as qn,
        (select count(*)::int from public.job where org_id = ${orgA} and customer_id = ${custId} and archived = false) as jn,
        (select count(*)::int from public.invoice where org_id = ${orgA} and customer_id = ${custId}) as inn`) as unknown as Array<{
      qn: number;
      jn: number;
      inn: number;
    }>;
    const [qn, jn, inn] = [counts[0]!.qn, counts[0]!.jn, counts[0]!.inn];
    expect(quotes.length).toBe(qn);
    expect(jobs.length).toBe(jn);
    expect(invoices.length).toBe(inn);
  });
});

describe("H19 — financial truth and the 360 aggregation", () => {
  it("customerMoney matches the shared derivation exactly", async () => {
    const ctx = ctxOf(orgA, userA);
    const [cm, list, ar, map] = await Promise.all([
      customerMoney(ctx, "owner", custId, asOf),
      listOutstandingInvoices(ctx, "owner", asOf, "all", { customerId: custId }),
      computeAR(ctx, "owner", asOf),
      customerOutstandingMap(ctx, "owner", asOf),
    ]);
    const listSum = (list ?? []).reduce((n, r) => n + r.balanceMinor, 0);
    expect(cm!.outstandingMinor).toBe(listSum);
    // The single customer holds ALL the org's outstanding here.
    expect(cm!.outstandingMinor).toBe(ar.outstandingMinor);
    expect(map!.get(custId)).toBe(cm!.outstandingMinor);
    expect(cm!.invoicedMinor).toBeGreaterThan(0);
    expect(cm!.paidMinor).toBe(0); // invoiced and paid stay distinct
  });

  it("restricted roles get null money and null totals, never zeros", async () => {
    const noPrice = ctxOf(orgA, userA, false);
    expect(await customerMoney(noPrice, "owner", custId, asOf)).toBeNull();
    expect(await customerOutstandingMap(noPrice, "owner", asOf)).toBeNull();
    const v = await gatherCustomer360(noPrice, "owner", custId, { asOf });
    expect(v!.moneyState).toBe("restricted");
    expect(v!.quotes!.every((q) => q.totalMinor === null)).toBe(true);
  });

  it("the 360 aggregation links every lifecycle object", async () => {
    const v = await gatherCustomer360(ctxOf(orgA, userA), "owner", custId, { asOf });
    expect(v!.customer.displayName).toBe("Marina Holdings");
    expect(v!.quotes!.length).toBeGreaterThanOrEqual(1);
    expect(v!.jobs!.length).toBeGreaterThanOrEqual(1);
    expect(v!.moneyState).toBe("ok");
    expect(v!.failed).toEqual([]);
    const kinds = v!.timeline!.map((e) => e.kind);
    expect(kinds).toContain("customer_created");
    expect(kinds).toContain("quote_created");
    expect(kinds).toContain("quote_accepted");
    expect(kinds).toContain("job_created");
    expect(kinds).toContain("invoice_issued");
  });

  it("timeline authorization: a manager sees no invoice or payment events", async () => {
    const events = await listCustomerTimeline(ctxOf(orgA, userA, false), "manager", custId);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("quote_created"); // quotes.view: O/A/M/Accounts
    expect(kinds).toContain("job_created");
    expect(kinds).not.toContain("invoice_issued"); // invoices.view: O/A/Accounts
    expect(kinds).not.toContain("payment_recorded");
  });

  it("cross-organization denial: org B reads none of it", async () => {
    expect(await gatherCustomer360(ctxOf(orgB, userB), "owner", custId, { asOf })).toBeNull();
    expect(await listCustomerTimeline(ctxOf(orgB, userB), "owner", custId)).toEqual([]);
    expect(await listQuotes(ctxOf(orgB, userB), "owner", { customerId: custId })).toEqual([]);
  });
});

describe("H19 — contacts, duplicates and archival", () => {
  it("normalized contacts: primary uniqueness and the legacy adapter", async () => {
    const ctx = ctxOf(orgA, userA);
    // Before any normalized rows: the embedded contact adapts as primary.
    let v = await gatherCustomer360(ctx, "owner", custId, { asOf });
    expect(v!.customer.primaryContact?.legacy).toBe(true);
    expect(v!.customer.primaryContact?.name).toBe("Huda");
    await addCustomerContact(ctx, "owner", custId, {
      name: "Salem",
      roleTitle: "Project engineer",
      phone: "+971 50 700 0001",
      isPrimary: true,
    });
    await addCustomerContact(ctx, "owner", custId, {
      name: "Mariam",
      email: "mariam@marina.example",
      isPrimary: true, // takes over primary; Salem demoted, not deleted
    });
    const contacts = await listCustomerContacts(ctx, "owner", custId);
    expect(contacts).toHaveLength(2);
    expect(contacts.filter((c) => c.isPrimary)).toHaveLength(1);
    expect(contacts.find((c) => c.isPrimary)?.name).toBe("Mariam");
    v = await gatherCustomer360(ctx, "owner", custId, { asOf });
    expect(v!.customer.primaryContact?.name).toBe("Mariam");
    expect(v!.customer.primaryContact?.legacy).toBeUndefined();
    // A foreign customer id cannot receive contacts.
    await expect(
      addCustomerContact(ctxOf(orgB, userB), "owner", custId, { name: "Intruder" }),
    ).rejects.toThrow();
  });

  it("possible duplicates match normalized email/phone inside the org only", async () => {
    const ctx = ctxOf(orgA, userA);
    const byEmail = await findPossibleDuplicates(ctx, "owner", {
      email: "  ACCOUNTS@Marina.Example ",
    });
    expect(byEmail.some((d) => d.id === custId && d.matchedOn === "email")).toBe(true);
    const byPhone = await findPossibleDuplicates(ctx, "owner", { phone: "04-555-0100" });
    expect(byPhone.some((d) => d.id === custId && d.matchedOn === "phone")).toBe(true);
    // Org B probing the same identifiers sees nothing (no cross-org leak).
    const cross = await findPossibleDuplicates(ctxOf(orgB, userB), "owner", {
      email: "accounts@marina.example",
    });
    expect(cross).toEqual([]);
  });

  it("archive preserves linked records and blocks NEW transactions only", async () => {
    const ctx = ctxOf(orgA, userA);
    await setCustomerActive(ctx, "owner", custId, false);
    // History intact and still reachable.
    const v = await gatherCustomer360(ctx, "owner", custId, { asOf });
    expect(v!.customer.active).toBe(false);
    expect(v!.quotes!.length).toBeGreaterThan(0);
    expect(v!.jobs!.length).toBeGreaterThan(0);
    // New documents refuse the archived customer.
    await expect(
      createQuote(ctx, "owner", {
        customerId: custId,
        lines: [{ description: "x", qty: 1, unit: "lot", unitPriceMinor: 100 }],
      }),
    ).rejects.toThrow(/archived/);
    await setCustomerActive(ctx, "owner", custId, true); // restore
  });
});
