/**
 * D4 — customer acceptance and project conversion are two steps when the
 * quotation has no template.
 *
 * A quotation without a template used to refuse acceptance outright (and the
 * screen offered the button anyway). Now acceptance records the customer's
 * decision — dated, noted, identity frozen, linked opportunity won — and the
 * project starts later from `convertQuoteToJob`, with the template chosen
 * then. A quotation that already has a template still does both at once.
 * Self-cleaning (wipeOrgs).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate } from "@/platform/config/install";
import { createCustomer } from "@/modules/masters/service";
import { listActivePresets } from "@/modules/jobs/service";
import {
  acceptQuote,
  convertQuoteToJob,
  createQuote,
  getQuote,
  QuoteStateError,
} from "@/modules/quotes/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
let presetA = "";
let custId = "";

const ctx = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "stab-quote-accept",
});

async function newQuote(presetId?: string): Promise<string> {
  const q = await createQuote(ctx(), "owner", {
    customerId: custId,
    ...(presetId ? { presetId } : {}),
    lines: [{ description: "Boundary wall", qty: 1, unit: "lot", unitPriceMinor: 4_800_000 }],
  });
  // The approval workflow is exercised elsewhere; here the quotation is
  // already with the customer.
  await owner`update public.quote set status = 'sent', updated_at = now()
              where id = ${q.id} and org_id = ${orgA}`;
  return q.id;
}

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`stab-quote-${run}@example.com`}, '{"full_name":"STAB"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, {
    name: `STAB quote ${run}`,
    country: "AE",
    baseCurrency: "AED",
  });
  await markFixtureOrg(owner, orgA, "stab-quote-accept", run);
  await installTemplate(ctx(), "construction_v1");
  presetA = (await listActivePresets(ctx(), "owner"))[0]!.id;
  ({ id: custId } = await createCustomer(ctx(), "owner", {
    name: "Coastal Developments",
    phone: "+971 4 555 0100",
  }));
}, 180_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA]);
  await owner.end();
  await closeAppDb();
});

describe("acceptance without a template", () => {
  let quoteId = "";

  it("records the customer's acceptance and starts no project", async () => {
    quoteId = await newQuote();
    const r = await acceptQuote(ctx(), "owner", quoteId, { note: "Signed by the customer" });
    expect(r).toEqual({ jobId: null, status: "accepted" });
    const q = (await getQuote(ctx(), "owner", quoteId))!;
    expect(q.status).toBe("accepted");
    expect(q.presetId).toBeNull();
    expect(q.acceptedAt).toBeTruthy();
    expect(q.acceptedNote).toBe("Signed by the customer");
    expect(q.convertedJobId).toBeNull();
    const [audit] = await owner`select action from public.audit_log
      where org_id = ${orgA} and entity_id = ${quoteId} and action = 'quote.accept'`;
    expect(audit).toBeTruthy();
  });

  it("refuses a second acceptance", async () => {
    await expect(acceptQuote(ctx(), "owner", quoteId, {})).rejects.toBeInstanceOf(QuoteStateError);
  });

  it("refuses to convert without a template, and converts once one is chosen", async () => {
    await expect(convertQuoteToJob(ctx(), "owner", quoteId, { presetId: "" })).rejects.toThrow();
    const { jobId } = await convertQuoteToJob(ctx(), "owner", quoteId, {
      presetId: presetA,
      jobName: "Boundary wall works",
    });
    expect(jobId).toBeTruthy();
    const q = (await getQuote(ctx(), "owner", quoteId))!;
    expect(q.status).toBe("converted");
    expect(q.presetId).toBe(presetA);
    expect(q.convertedJobId).toBe(jobId);
    // The acceptance the customer gave is untouched by the conversion.
    expect(q.acceptedNote).toBe("Signed by the customer");
    const [job] =
      await owner`select name, origin from public.job where id = ${jobId} and org_id = ${orgA}`;
    expect(job).toMatchObject({ name: "Boundary wall works", origin: "quotation" });
  });

  it("refuses to convert a quotation that is not accepted, or already converted", async () => {
    const fresh = await newQuote();
    await expect(
      convertQuoteToJob(ctx(), "owner", fresh, { presetId: presetA }),
    ).rejects.toBeInstanceOf(QuoteStateError);
    await expect(
      convertQuoteToJob(ctx(), "owner", quoteId, { presetId: presetA }),
    ).rejects.toBeInstanceOf(QuoteStateError);
  });
});

describe("acceptance with a template", () => {
  it("still accepts and converts in one step", async () => {
    const quoteId = await newQuote(presetA);
    const r = await acceptQuote(ctx(), "owner", quoteId, { note: "PO attached" });
    expect(r.status).toBe("converted");
    expect(r.jobId).toBeTruthy();
    const q = (await getQuote(ctx(), "owner", quoteId))!;
    expect(q.status).toBe("converted");
    expect(q.convertedJobId).toBe(r.jobId);
    expect(q.acceptedNote).toBe("PO attached");
  });
});
