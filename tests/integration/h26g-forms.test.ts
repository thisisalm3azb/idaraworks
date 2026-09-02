/**
 * H26G — forms on the TEST project: a form link is hashed, expiring and
 * use-capped; an outside party's answers are validated against the issued
 * snapshot (kinds, required, conditional sections) and land in a quarantined
 * row under the right organisation; nothing becomes a record until a
 * reviewer converts it explicitly under their own permissions; a viewer
 * cannot convert; the link stops resolving when revoked or exhausted.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 240_000 });
import { ForbiddenError } from "@/platform/authz";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import { getCustomer } from "@/modules/masters/service";
import {
  convertSubmission,
  createDocument,
  createFormLink,
  getDocument,
  issueDocument,
  listFormLinks,
  listSubmissions,
  resolveFormToken,
  revokeFormLink,
  reviewSubmission,
  submitForm,
  validateAnswers,
  BUILT_IN_TEMPLATES,
} from "@/modules/docstudio/service";
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
  requestId: "h26g",
});
const A = () => ctxOf(userA);
const V = () => ctxOf(userV);
const info = { ip: "198.51.100.7", userAgent: "vitest" };

beforeAll(async () => {
  for (const [id, name] of [
    [userA, "Owner"],
    [userV, "Viewer"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h26g-${name.toLowerCase()}-${run}@example.invalid`},
              ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H26G", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h26g", run);
  await owner`
    insert into public.user_profile (id, full_name, locale) values (${userV}, 'Viewer', 'en')
    on conflict (id) do nothing`;
  await owner`
    insert into public.membership (user_id, org_id, role_key) values (${userV}, ${orgA}, 'viewer')`;
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA, userV]);
  await owner.end();
  await closeAppDb();
});

describe("answer validation (pure)", () => {
  const body = BUILT_IN_TEMPLATES.find((t) => t.key === "builtin.intake_form")!.body;
  it("enforces required, kinds, choices and conditional sections", () => {
    const bad = validateAnswers(body, {
      company_name: "",
      email: "nope",
      phone: "",
      customer_type: "9",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.problems.company_name).toBe("required");
      expect(bad.problems.email).toBe("email");
      expect(bad.problems.customer_type).toBe("choice");
      expect(bad.problems.consent).toBe("required");
    }
    // Individual (choice 1) hides the business section: license_no is not required and is dropped.
    const ok = validateAnswers(body, {
      company_name: "Salma",
      email: "salma@example.invalid",
      phone: "+971500000000",
      customer_type: "1",
      consent: "on",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.answers.customer_type).toBe(1);
      expect(ok.answers.consent).toBe(true);
      expect("license_no" in ok.answers).toBe(false);
    }
  });
});

describe("links and submissions", () => {
  let formId = "";
  let token = "";
  let linkId = "";
  it("a link needs an issued form; the token is hashed and use-capped", async () => {
    const d = await createDocument(A(), "owner", {
      title: `Intake ${run}`,
      category: "form",
      language: "bilingual",
      builtinKey: "builtin.intake_form",
    });
    formId = d.id;
    await expect(createFormLink(A(), "owner", { documentId: formId })).rejects.toMatchObject({
      code: "state",
    });
    const issued = await issueDocument(A(), "owner", { documentId: formId });
    expect(issued.status).toBe("active");
    const link = await createFormLink(A(), "owner", {
      documentId: formId,
      label: "Website",
      expiresInDays: 7,
      maxUses: 2,
    });
    linkId = link.id;
    token = link.url.split("/f/")[1]!;
    expect(token.length).toBeGreaterThan(30);
    const rows = await listFormLinks(A(), "owner", formId);
    expect(rows[0]?.maxUses).toBe(2);
    expect(rows[0]?.useCount).toBe(0);
    await expect(createFormLink(V(), "viewer", { documentId: formId })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("an outside party submits validated answers into a quarantined row; bad answers are refused", async () => {
    const resolved = await resolveFormToken(token);
    expect(resolved?.documentId).toBe(formId);
    const bad = await submitForm(resolved!, token, { company_name: "" }, info);
    expect("problems" in bad).toBe(true);
    const good = await submitForm(
      resolved!,
      token,
      {
        company_name: "Salma Trading",
        contact_name: "Salma",
        email: "salma@example.invalid",
        phone: "+971500000000",
        customer_type: "0",
        license_no: "CN-1",
        consent: "on",
      },
      { ...info, name: "Salma", email: "salma@example.invalid" },
    );
    expect("id" in good).toBe(true);
    const subs = await listSubmissions(A(), "owner", { documentId: formId });
    expect(subs.length).toBe(1);
    expect(subs[0]!.status).toBe("received");
    expect(subs[0]!.answers.company_name).toBe("Salma Trading");
    expect(subs[0]!.submitterEmail).toBe("salma@example.invalid");
    const d = await getDocument(A(), "owner", formId);
    expect(d.events.map((e) => e.kind)).toContain("form_submitted");
    expect(d.chain).toEqual({ ok: true });
    // Nothing was created yet: no customer with that name.
    const customers =
      (await owner`select count(*)::int as n from public.customer where org_id = ${orgA} and name = 'Salma Trading'`) as unknown as Array<{
        n: number;
      }>;
    expect(Number(customers[0]!.n)).toBe(0);
  });

  it("conversion is explicit, permissioned, and mapped", async () => {
    const sub = (await listSubmissions(A(), "owner", { documentId: formId }))[0]!;
    await expect(
      convertSubmission(V(), "viewer", { submissionId: sub.id, target: "customer" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const r = await convertSubmission(A(), "owner", {
      submissionId: sub.id,
      target: "customer",
      mapping: {
        name: "company_name",
        contactName: "contact_name",
        email: "email",
        phone: "phone",
      },
    });
    expect(r.recordType).toBe("customer");
    const c = await getCustomer(A(), "owner", r.recordId);
    expect(c?.name).toBe("Salma Trading");
    expect(c?.contactName).toBe("Salma");
    const after = (await listSubmissions(A(), "owner", { documentId: formId }))[0]!;
    expect(after.status).toBe("converted");
    expect(after.convertedRecordId).toBe(r.recordId);
    await expect(
      convertSubmission(A(), "owner", { submissionId: sub.id, target: "customer" }),
    ).rejects.toMatchObject({ code: "state" });
    await expect(
      reviewSubmission(A(), "owner", { submissionId: sub.id, decision: "discarded" }),
    ).rejects.toMatchObject({ code: "state" });
  });

  it("the use cap and revocation stop the link", async () => {
    const resolved = await resolveFormToken(token);
    const second = await submitForm(
      resolved!,
      token,
      {
        company_name: "Second Co",
        email: "b@example.invalid",
        phone: "1",
        customer_type: "1",
        consent: "on",
      },
      info,
    );
    expect("id" in second).toBe(true);
    // Two uses consumed: the resolver refuses a third.
    expect(await resolveFormToken(token)).toBeNull();
    const links = await listFormLinks(A(), "owner", formId);
    expect(links[0]?.useCount).toBe(2);
    const fresh = await createFormLink(A(), "owner", { documentId: formId, expiresInDays: 1 });
    const t2 = fresh.url.split("/f/")[1]!;
    expect(await resolveFormToken(t2)).not.toBeNull();
    await revokeFormLink(A(), "owner", { linkId: fresh.id });
    expect(await resolveFormToken(t2)).toBeNull();
    // A stale resolved handle cannot submit after revocation (the definer re-checks).
    await expect(
      submitForm(
        { ...resolved!, linkId: fresh.id },
        t2,
        {
          company_name: "x",
          email: "x@example.invalid",
          phone: "1",
          customer_type: "1",
          consent: "on",
        },
        info,
      ),
    ).rejects.toMatchObject({ code: "expired" });
    expect(linkId).not.toBe("");
  });
});
