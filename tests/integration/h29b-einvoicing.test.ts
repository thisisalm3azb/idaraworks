/**
 * H29B — electronic invoicing against the real database.
 *
 * The mandate's rule is blunt: never fabricate a successful authority response,
 * keep submission disabled without credentials, and send no genuine production
 * invoice to an authority during H29. This suite proves the code cannot do any
 * of those things even when asked to.
 *
 * It also proves the parts that must work WITHOUT a credential: the document is
 * still built, hashed, chained and given a QR payload, because that is what an
 * organisation needs in order to be ready the day a credential arrives.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 240_000 });
import { createOrgForUser } from "@/platform/auth/identity";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { SA_PACK } from "@/platform/country";
import { adoptPack, createEstablishment } from "@/modules/country/service";
import {
  configureChannel,
  createChannel,
  listChannels,
  listDocuments,
  prepareDocument,
  submitDocument,
  ZATCA_OWNER_ACTION,
} from "@/modules/einvoicing/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userB = randomUUID();
let orgA = "";
let orgB = "";
let riyadh = "";
let channelId = "";

const ctxOf = (orgId: string, userId: string): Ctx => ({
  orgId,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h29b",
});
const A = () => ctxOf(orgA, userA);
const B = () => ctxOf(orgB, userB);

/** No credential of any kind is visible to this suite. */
const NO_CREDENTIALS: Record<string, string | undefined> = { APP_ENV: "test" };

async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return `${err.message} :: ${err.cause?.message ?? ""}`;
  }
  throw new Error("expected a refusal, but the call succeeded");
}

const invoice = (n: number) => ({
  kind: "tax_invoice" as const,
  id: randomUUID(),
  reference: `INV-${run}-${n}`,
  issuedAt: "2026-10-05T09:00:00.000Z",
  currency: "SAR",
  totalMinor: 11_500,
  taxTotalMinor: 1_500,
  seller: {
    name: `Riyadh Works ${run}`,
    taxNumber: "300000000000003",
    address: {
      buildingNumber: "1234",
      street: "King Fahd",
      district: "Olaya",
      city: "Riyadh",
      postalCode: "12345",
    },
  },
  // A STANDARD tax invoice must name its customer and carry their address
  // (Article 53(5)); a simplified one need not. The suite below proves the
  // adapter enforces that rather than assuming it.
  buyer: {
    name: "A Customer",
    taxNumber: null,
    address: { buildingNumber: "5678", street: "Tahlia", district: "Sulimaniyah", city: "Riyadh" },
  },
  lines: [
    {
      description: "Consultancy",
      quantity: 1,
      unitPriceMinor: 10_000,
      taxRatePercent: 15,
      taxAmountMinor: 1_500,
      lineTotalMinor: 11_500,
    },
  ],
});

beforeAll(async () => {
  for (const [id, name] of [
    [userA, "H29B Owner A"],
    [userB, "H29B Owner B"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h29b-${id.slice(0, 8)}-${run}@example.invalid`},
              ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, {
    name: `H29B A ${run}`,
    country: "SA",
    baseCurrency: "SAR",
  });
  orgB = await createOrgForUser(userB, {
    name: `H29B B ${run}`,
    country: "SA",
    baseCurrency: "SAR",
  });
  await markFixtureOrg(owner, orgA, "h29b", run);
  await markFixtureOrg(owner, orgB, "h29b", run);

  riyadh = (
    await createEstablishment(A(), "owner", {
      code: "RUH",
      legalName: `Riyadh Works ${run}`,
      country: "SA",
      timezone: "Asia/Riyadh",
      baseCurrency: "SAR",
      isPrimary: true,
      address: {
        buildingNumber: "1234",
        street: "King Fahd",
        district: "Olaya",
        city: "Riyadh",
        postalCode: "12345",
      },
    })
  ).id;
  await adoptPack(A(), "owner", {
    establishmentId: riyadh,
    packKey: SA_PACK.packKey,
    effectiveFrom: SA_PACK.effectiveFrom,
  });
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA, orgB], [userA, userB]);
  await owner.end();
  await closeAppDb();
});

describe("a channel exists before a credential does", () => {
  it("is created disabled, naming what its country's authority requires", async () => {
    const channel = await createChannel(A(), "owner", {
      establishmentId: riyadh,
      adapterKey: "zatca",
      environment: "sandbox",
    });
    channelId = channel.id;
    expect(channel.adapterKey).toBe("zatca");
    expect(channel.credentialPresent).toBe(false);
  });

  it("stores the NAME of a server variable, never a secret", async () => {
    // Anything that looks like a value rather than a variable name is refused,
    // so a credential cannot be pasted into the database by accident.
    expect(
      await refusal(() =>
        configureChannel(A(), "owner", { id: channelId, credentialRef: "eyJhbGciOi.secret" }),
      ),
    ).toMatch(/NAME of a server variable|invalid/i);
    const configured = await configureChannel(A(), "owner", {
      id: channelId,
      credentialRef: "ZATCA_SANDBOX_CSID",
    });
    expect(configured.credentialRef).toBe("ZATCA_SANDBOX_CSID");
  });

  it("naming a variable that does not exist is not the same as having one", async () => {
    const [channel] = await listChannels(A(), riyadh, NO_CREDENTIALS);
    expect(channel!.credentialRef).toBe("ZATCA_SANDBOX_CSID");
    expect(channel!.credentialPresent).toBe(false);
  });

  it("an empty or blank variable counts as absent", async () => {
    const [blank] = await listChannels(A(), riyadh, { ZATCA_SANDBOX_CSID: "   " });
    expect(blank!.credentialPresent).toBe(false);
    const [present] = await listChannels(A(), riyadh, { ZATCA_SANDBOX_CSID: "a-real-value" });
    expect(present!.credentialPresent).toBe(true);
  });
});

describe("preparation works without a credential; submission does not", () => {
  let firstId = "";

  it("prepares a document, hashes it and chains it", async () => {
    const result = await prepareDocument(
      A(),
      "owner",
      { channelId, document: invoice(1) },
      NO_CREDENTIALS,
    );
    firstId = result.document.id;
    expect(result.document.counter).toBe(1);
    expect(result.document.documentHash).toBeTruthy();
    expect(result.document.qrPayload).toBeTruthy();
    // The first document in a chain has no predecessor, and the value ZATCA
    // requires in that position could not be read from a primary source. It is
    // left empty and REPORTED rather than filled with a guess — the mandate
    // forbids inventing a value an authority will check.
    expect(result.document.previousHash).toBeNull();
    expect(result.issues.map((i) => i.code)).toContain("pih-initial-unknown");
    expect(result.issues.every((i) => i.severity === "warning")).toBe(true);
  });

  it("the counter increments per channel and the chain links", async () => {
    const second = await prepareDocument(
      A(),
      "owner",
      { channelId, document: invoice(2) },
      NO_CREDENTIALS,
    );
    expect(second.document.counter).toBe(2);
    const first = (await listDocuments(A(), channelId, { limit: 200, offset: 0 })).rows.find(
      (d) => d.id === firstId,
    )!;
    expect(second.document.previousHash).toBe(first.documentHash);
  });

  it("preparing the same source twice returns the same document, not a second one", async () => {
    const source = invoice(3);
    const once = await prepareDocument(
      A(),
      "owner",
      { channelId, document: source },
      NO_CREDENTIALS,
    );
    const twice = await prepareDocument(
      A(),
      "owner",
      { channelId, document: source },
      NO_CREDENTIALS,
    );
    expect(twice.document.id).toBe(once.document.id);
    expect(twice.document.counter).toBe(once.document.counter);
  });

  it("Article 53 fields are enforced, not assumed", async () => {
    // A standard tax invoice with no customer address is reported by NAME, with
    // the rule cited, rather than accepted here and rejected by ZATCA later.
    const bad = { ...invoice(90), buyer: { name: "A Customer", taxNumber: null, address: {} } };
    const result = await prepareDocument(
      A(),
      "owner",
      { channelId, document: bad },
      NO_CREDENTIALS,
    );
    const errors = result.issues.filter((i) => i.severity === "error").map((i) => i.code);
    expect(errors).toContain("BR-KSA-customer-address");
    // A document carrying errors is never treated as ready to send.
    expect(result.document.status).not.toBe("ready");
  });

  it("submission without a credential is UNAVAILABLE, never a success and never a failure", async () => {
    const result = await submitDocument(A(), "owner", firstId, NO_CREDENTIALS);
    expect(result.state).toBe("unavailable");
    // The distinction matters: "failed" invites a retry, "unavailable" says the
    // deployment is not set up and names who has to do what.
    expect(result.ownerAction).toBe(ZATCA_OWNER_ACTION);
    expect(result.document.status).not.toBe("cleared");
    expect(result.document.submittedAt).toBeNull();
  });

  it("no attempt is recorded as a submission to an authority", async () => {
    const rows = await owner`
      select outcome from public.einvoice_event
       where org_id = ${orgA} and document_id = ${firstId} order by attempt`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.outcome).toBe("unavailable");
    // Nothing anywhere in this organisation claims a cleared or reported state.
    const cleared = await owner`
      select count(*)::int as n from public.einvoice_document
       where org_id = ${orgA} and status in ('cleared', 'reported')`;
    expect(cleared[0]!.n).toBe(0);
  });

  it("the event log has no update grant, so an outcome cannot be rewritten", async () => {
    const grants = (
      await owner`
        select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'einvoice_event' and grantee = 'app_user'`
    ).map((r) => r.privilege_type);
    expect(grants).toContain("INSERT");
    expect(grants).toContain("SELECT");
    expect(grants).not.toContain("UPDATE");
    expect(grants).not.toContain("DELETE");
  });
});

describe("the document list pages", () => {
  it("returns a page at a time and never everything", async () => {
    const page = await listDocuments(A(), channelId, { limit: 2, offset: 0 });
    expect(page.rows).toHaveLength(2);
    // The total is reported separately, so a caller can page without guessing.
    expect(page.total).toBeGreaterThan(2);
    const next = await listDocuments(A(), channelId, { limit: 2, offset: 2 });
    expect(next.rows.length).toBeGreaterThan(0);
    expect(page.rows.map((d) => d.id)).not.toEqual(next.rows.map((d) => d.id));
    // An absurd request is clamped rather than honoured.
    const clamped = await listDocuments(A(), channelId, { limit: 100_000, offset: 0 });
    expect(clamped.rows.length).toBeLessThanOrEqual(200);
  });
});

describe("nothing leaks between tenants", () => {
  it("another tenant sees no channel and no document", async () => {
    expect(await listChannels(B(), riyadh, NO_CREDENTIALS)).toEqual([]);
    expect((await listDocuments(B(), channelId, { limit: 200, offset: 0 })).rows).toEqual([]);
  });

  it("another tenant cannot prepare against a channel it cannot see", async () => {
    expect(
      await refusal(() =>
        prepareDocument(B(), "owner", { channelId, document: invoice(9) }, NO_CREDENTIALS),
      ),
    ).toMatch(/not found/i);
  });

  it("another tenant cannot submit a document it cannot see", async () => {
    const [mine] = (await listDocuments(A(), channelId, { limit: 1, offset: 0 })).rows;
    expect(await refusal(() => submitDocument(B(), "owner", mine!.id, NO_CREDENTIALS))).toMatch(
      /not found/i,
    );
  });
});
