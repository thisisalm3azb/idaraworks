/**
 * H27D — CRM imports on the TEST project: contacts, leads and opportunities
 * stage through the same governed importer as customers; the preview is a
 * read-only dry run that reports in-batch and existing duplicates and rows
 * whose customer cannot be resolved; skipped rows are never created; apply
 * is idempotent (a second apply creates nothing); imported leads carry the
 * "import" source, are not quarantined, and every created record is audited.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 240_000 });
import { ForbiddenError } from "@/platform/authz";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { createCustomer, listCustomerContacts } from "@/modules/masters/service";
import {
  applyImport,
  listImportRows,
  previewImport,
  skipImportRows,
  stageImport,
} from "@/modules/imports/service";
import { captureLead, leadPage, listOpportunities } from "@/modules/crm/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userV = randomUUID();
let orgA = "";
const ctxOf = (userId: string): Ctx => ({
  orgId: orgA,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h27d",
});
const A = () => ctxOf(userA);
const V = () => ctxOf(userV);

beforeAll(async () => {
  for (const [id, name] of [
    [userA, "Owner"],
    [userV, "Viewer"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h27d-${name.toLowerCase()}-${run}@example.invalid`}, ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H27D", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h27d", run);
  await owner`insert into public.user_profile (id, full_name, locale) values (${userV}, 'Viewer', 'en') on conflict (id) do nothing`;
  await owner`insert into public.membership (user_id, org_id, role_key) values (${userV}, ${orgA}, 'viewer')`;
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA, userV]);
  await owner.end();
  await closeAppDb();
});

describe("contacts import", () => {
  it("resolves customers by name, previews duplicates and unresolved rows, skips, applies once", async () => {
    const c = await createCustomer(A(), "owner", { name: `Harbour Ltd ${run}`, country: "AE" });
    const staged = await stageImport(A(), "owner", {
      kind: "contacts",
      filename: "contacts.csv",
      rows: [
        {
          Customer: `Harbour Ltd ${run}`,
          Name: "Aisha",
          Email: `aisha-${run}@example.invalid`,
          Title: "Buyer",
          Primary: "yes",
        },
        { Customer: `harbour ltd ${run}`, Name: "Omar", Phone: "+971500000001" },
        { Customer: `Harbour Ltd ${run}`, Name: "aisha", Email: `AISHA-${run}@example.invalid` }, // in-batch duplicate
        { Customer: `Nobody Inc ${run}`, Name: "Ghost" }, // unresolved customer
        { Customer: `Harbour Ltd ${run}`, Name: "" }, // invalid: empty name
      ],
    });
    expect(staged.total).toBe(5);
    expect(staged.valid).toBe(4);
    expect(staged.invalid).toBe(1);
    const preview = await previewImport(A(), "owner", staged.batchId);
    expect(preview.kind).toBe("contacts");
    expect(preview.unresolved).toEqual([
      { rowNumber: 4, reason: `customer not found: Nobody Inc ${run}` },
    ]);
    expect(
      preview.duplicates.some(
        (d) => d.rowNumber === 3 && d.kind === "in_batch" && d.rowNumber2 === 1,
      ),
    ).toBe(true);
    expect(preview.wouldCreate).toBe(3);
    // Preview wrote nothing.
    expect((await listCustomerContacts(A(), "owner", c.id)).length).toBe(0);
    await expect(previewImport(V(), "viewer", staged.batchId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const skipped = await skipImportRows(A(), "owner", staged.batchId, [3]);
    expect(skipped.skipped).toBe(1);
    const applied = await applyImport(A(), "owner", staged.batchId);
    expect(applied.applied).toBe(2);
    expect(applied.failed).toBe(1); // the unresolved customer row fails with a clear message
    const rows = await listImportRows(A(), "owner", staged.batchId);
    expect(rows.find((r) => r.rowNumber === 4)?.error).toContain("customer not found");
    expect(rows.find((r) => r.rowNumber === 3)?.error).toContain("skipped");
    const contacts = await listCustomerContacts(A(), "owner", c.id);
    expect(contacts.map((x) => x.name).sort()).toEqual(["Aisha", "Omar"]);
    expect(contacts.find((x) => x.name === "Aisha")?.isPrimary).toBe(true);
    // Idempotent: nothing left to apply.
    const again = await applyImport(A(), "owner", staged.batchId);
    expect(again).toEqual({ applied: 0, failed: 0 });
    // A second preview now reports the existing contacts as duplicates.
    const staged2 = await stageImport(A(), "owner", {
      kind: "contacts",
      rows: [{ Customer: `Harbour Ltd ${run}`, Name: "Omar" }],
    });
    const p2 = await previewImport(A(), "owner", staged2.batchId);
    expect(p2.duplicates.map((d) => [d.kind, d.matchedOn, d.name])).toEqual([
      ["existing", "name", "Omar"],
    ]);
  });
});

describe("leads import", () => {
  it("creates import-sourced leads that are not quarantined, flags existing duplicates, and audits", async () => {
    await captureLead(A(), "owner", {
      name: `Existing Lead ${run}`,
      email: `dup-${run}@example.invalid`,
      sourceKind: "manual",
    });
    const staged = await stageImport(A(), "owner", {
      kind: "leads",
      rows: [
        {
          Name: `Fresh Lead ${run}`,
          Email: `fresh-${run}@example.invalid`,
          Country: "AE",
          Value: "150000",
          Source: "Boat show",
        },
        { Name: `Dup Lead ${run}`, Email: `dup-${run}@example.invalid` },
        { Name: `Bad Lead ${run}`, Email: "not-an-email" },
      ],
    });
    expect(staged.valid).toBe(2);
    expect(staged.invalid).toBe(1);
    const preview = await previewImport(A(), "owner", staged.batchId);
    expect(
      preview.duplicates.some(
        (d) => d.rowNumber === 2 && d.kind === "existing" && d.matchedOn === "email",
      ),
    ).toBe(true);
    await skipImportRows(A(), "owner", staged.batchId, [2]);
    const applied = await applyImport(A(), "owner", staged.batchId);
    expect(applied).toEqual({ applied: 1, failed: 0 });
    const page = await leadPage(A(), "owner", { q: `Fresh Lead ${run}`, limit: 10 });
    const fresh = page.rows.find((r) => r.name === `Fresh Lead ${run}`);
    expect(fresh).toBeTruthy();
    expect(page.rows.some((r) => r.name === `Dup Lead ${run}`)).toBe(false); // skipped row never created
    expect(fresh!.sourceKind).toBe("import");
    expect(fresh!.quarantine).toBe("trusted");
    expect(fresh!.estimatedValueMinor).toBe(150000);
    const audit = (await owner`
      select count(*)::int as n from public.audit_log where org_id = ${orgA} and action = 'lead.create'`) as unknown as Array<{
      n: number;
    }>;
    expect(audit[0]!.n).toBeGreaterThanOrEqual(2);
  });
});

describe("opportunities import", () => {
  it("attaches to resolved customers, rejects unknown stages, and reports open-opportunity duplicates", async () => {
    await createCustomer(A(), "owner", { name: `Yacht Club ${run}`, country: "AE" });
    const staged = await stageImport(A(), "owner", {
      kind: "opportunities",
      rows: [
        {
          Opportunity: `Tender ${run}`,
          Customer: `Yacht Club ${run}`,
          Stage: "qualified",
          Value: "900000",
          "Close date": "2027-03-31",
          Probability: "40",
        },
        { Opportunity: `No customer ${run}`, Value: "1000" },
        { Opportunity: `Bad stage ${run}`, Customer: `Yacht Club ${run}`, Stage: "Not A Stage" },
      ],
    });
    expect(staged.valid).toBe(2); // the stage regex rejects "Not A Stage" at staging
    const applied = await applyImport(A(), "owner", staged.batchId);
    expect(applied).toEqual({ applied: 2, failed: 0 });
    const opps = await listOpportunities(A(), "owner", {});
    const tender = opps.find((o) => o.name === `Tender ${run}`);
    expect(tender?.customerName).toBe(`Yacht Club ${run}`);
    expect(tender?.estimatedValueMinor).toBe(900000);
    expect(tender?.probability).toBe(40);
    const staged2 = await stageImport(A(), "owner", {
      kind: "opportunities",
      rows: [{ Opportunity: `tender ${run}`, Customer: `Yacht Club ${run}` }],
    });
    const p2 = await previewImport(A(), "owner", staged2.batchId);
    expect(p2.duplicates.map((d) => [d.kind, d.matchedOn])).toEqual([["existing", "name"]]);
  });
});
