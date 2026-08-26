/**
 * 003C — customer completeness (integration, real DB): the widened reads,
 * audited edit, explicit archive/reactivate lifecycle, tenant isolation,
 * selector exclusion of archived records, historical integrity on quotes,
 * and the quote-side wall against foreign/archived customer ids.
 * Self-cleaning (wipeOrgs); never touches protected production orgs.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import {
  createCustomer,
  getCustomer,
  listCustomers,
  setCustomerActive,
  updateCustomer,
} from "@/modules/masters/service";
import {
  createQuote,
  getQuote,
  listQuoteFormOptions,
  InvalidQuoteInputError,
} from "@/modules/quotes/service";
import { ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";
let customerId = "";
let foreignCustomerId = "";
let quoteId = "";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "cust-003c-test",
});
const ctxA = () => ctxOf(orgA, userA);
const ctxB = () => ctxOf(orgB, userB);

async function seedAuthUser(id: string, email: string) {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${email}, '{"full_name":"Customer Test"}'::jsonb, now(), now())`;
}

async function auditRows(action: string): Promise<number> {
  const rows = (await owner`
    select count(*)::int as n from public.audit_log
    where org_id = ${orgA} and action = ${action} and entity_id = ${customerId}`) as unknown as Array<{
    n: number;
  }>;
  return rows[0]!.n;
}

beforeAll(async () => {
  await seedAuthUser(userA, `cust-a-${run}@example.com`);
  await seedAuthUser(userB, `cust-b-${run}@example.com`);
  orgA = await createOrgForUser(userA, { name: "CUST-A", country: "AE", baseCurrency: "AED" });
  orgB = await createOrgForUser(userB, { name: "CUST-B", country: "AE", baseCurrency: "AED" });
  await installTemplate(ctxA(), TEMPLATE_BOATBUILDING.key);
  ({ id: foreignCustomerId } = await createCustomer(ctxB(), "owner", {
    name: "Foreign Marine Co",
  }));
}, 120_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]).catch(() => {});
  await owner.end({ timeout: 5 });
  await closeAppDb();
});

describe("detail read + edit", () => {
  it("creates and reads back the FULL record incl. timestamps", async () => {
    ({ id: customerId } = await createCustomer(ctxA(), "owner", {
      name: "Gulf Marine LLC",
      country: "AE",
      contactName: "Salem",
      phone: "+971 50 000 0000",
      email: "salem@gulf.example",
      taxRegNo: "100123456700003",
      notes: "VIP",
    }));
    const c = await getCustomer(ctxA(), "owner", customerId);
    expect(c).not.toBeNull();
    expect(c!.name).toBe("Gulf Marine LLC");
    expect(c!.contactName).toBe("Salem");
    expect(c!.email).toBe("salem@gulf.example");
    expect(c!.taxRegNo).toBe("100123456700003");
    expect(c!.notes).toBe("VIP");
    expect(c!.active).toBe(true);
    expect(Date.parse(c!.createdAt)).toBeGreaterThan(0);
    expect(Date.parse(c!.updatedAt)).toBeGreaterThan(0);
  });

  it("updateCustomer round-trips every editable field and PRESERVES active", async () => {
    await updateCustomer(ctxA(), "owner", customerId, {
      name: "Gulf Marine Industries LLC",
      country: "AE",
      contactName: "Salem A.",
      phone: "+971 50 111 1111",
      email: "office@gulf.example",
      taxRegNo: "100123456700003",
      notes: "VIP — NET30",
      active: true,
    });
    const c = await getCustomer(ctxA(), "owner", customerId);
    expect(c!.name).toBe("Gulf Marine Industries LLC");
    expect(c!.contactName).toBe("Salem A.");
    expect(c!.notes).toBe("VIP — NET30");
    expect(c!.active).toBe(true);
    expect(await auditRows("customer.update")).toBeGreaterThan(0);
  });

  it("tenant isolation: a foreign-org id reads as null, exactly like a missing one", async () => {
    expect(await getCustomer(ctxA(), "owner", foreignCustomerId)).toBeNull();
    expect(await getCustomer(ctxA(), "owner", randomUUID())).toBeNull();
    expect(await getCustomer(ctxA(), "owner", "not-a-uuid")).toBeNull();
  });
});

describe("search and filters (server-side, bounded)", () => {
  it("matches name, contact, phone, email and TRN; respects status filters", async () => {
    for (const q of ["gulf", "Salem", "111 1111", "office@", "10012345"]) {
      const rows = await listCustomers(ctxA(), "owner", { q, status: "all" });
      expect(
        rows.some((r) => r.id === customerId),
        `search '${q}' should find the customer`,
      ).toBe(true);
    }
    expect((await listCustomers(ctxA(), "owner", { q: "no-such-customer-xyz" })).length).toBe(0);
  });
});

describe("lifecycle: archive → hidden from selectors, history intact → reactivate", () => {
  it("a quote created while active snapshots the customer identity", async () => {
    const q = await createQuote(ctxA(), "owner", {
      customerId,
      lines: [
        { description: "Slipway works", qty: 1, unit: "ea", unitPriceMinor: 100000, vatRate: 5 },
      ],
    });
    quoteId = q.id;
    const detail = await getQuote(ctxA(), "owner", quoteId);
    expect(detail!.customerName).toBe("Gulf Marine Industries LLC");
  });

  it("archive: audited, idempotent, hidden from active lists and quote options", async () => {
    const first = await setCustomerActive(ctxA(), "owner", customerId, false);
    expect(first.changed).toBe(true);
    expect(await auditRows("customer.archive")).toBe(1);
    // Double submission is safe and writes NO second audit row.
    const second = await setCustomerActive(ctxA(), "owner", customerId, false);
    expect(second.changed).toBe(false);
    expect(await auditRows("customer.archive")).toBe(1);
    // Hidden from the default (active) list and from new-quote options…
    expect((await listCustomers(ctxA(), "owner", {})).some((r) => r.id === customerId)).toBe(false);
    expect((await listQuoteFormOptions(ctxA())).customers.some((c) => c.id === customerId)).toBe(
      false,
    );
    // …but still readable (detail + archived/all filters).
    expect((await getCustomer(ctxA(), "owner", customerId))!.active).toBe(false);
    expect(
      (await listCustomers(ctxA(), "owner", { status: "archived" })).some(
        (r) => r.id === customerId,
      ),
    ).toBe(true);
  });

  it("historical quote keeps its customer identity after archiving", async () => {
    const detail = await getQuote(ctxA(), "owner", quoteId);
    expect(detail!.customerName).toBe("Gulf Marine Industries LLC");
    const raw = (await owner`
      select customer_id::text as cid from public.quote where id = ${quoteId}`) as unknown as Array<{
      cid: string;
    }>;
    expect(raw[0]!.cid).toBe(customerId); // FK intact — never nulled
  });

  it("an ARCHIVED customer cannot be attached to a NEW quote (posted values included)", async () => {
    await expect(
      createQuote(ctxA(), "owner", {
        customerId,
        lines: [{ description: "x", qty: 1, unit: "ea", unitPriceMinor: 1000, vatRate: 0 }],
      }),
    ).rejects.toMatchObject({ message: "customer archived" });
  });

  it("a FOREIGN customer cannot be attached — indistinguishable from missing", async () => {
    for (const id of [foreignCustomerId, randomUUID()]) {
      await expect(
        createQuote(ctxA(), "owner", {
          customerId: id,
          lines: [{ description: "x", qty: 1, unit: "ea", unitPriceMinor: 1000, vatRate: 0 }],
        }),
      ).rejects.toSatisfy(
        (e: unknown) => e instanceof InvalidQuoteInputError && e.message === "customer not found",
      );
    }
  });

  it("reactivate: audited, back in the active selectors", async () => {
    const res = await setCustomerActive(ctxA(), "owner", customerId, true);
    expect(res.changed).toBe(true);
    expect(await auditRows("customer.reactivate")).toBe(1);
    expect((await listQuoteFormOptions(ctxA())).customers.some((c) => c.id === customerId)).toBe(
      true,
    );
    expect((await listCustomers(ctxA(), "owner", {})).some((r) => r.id === customerId)).toBe(true);
  });

  it("lifecycle requires customers.manage; foreman cannot archive", async () => {
    await expect(setCustomerActive(ctxA(), "foreman", customerId, false)).rejects.toThrow();
  });
});
