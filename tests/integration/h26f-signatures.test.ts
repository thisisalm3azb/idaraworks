/**
 * H26F — the signature room on the TEST project.
 *
 * Properties: a room opens only on an issued document awaiting signature and
 * only when every signature party has a signer; invitations are single use,
 * hashed, expiring and revocable; a member signs in-app only for their own
 * party; an external signer signs through the resolver with an evidence
 * record; the last signature activates the document and the timeline stays
 * verifiable; a used or revoked token resolves to nothing; declining closes
 * the request; the PDF render seam lists signatures and evidence; an
 * unprovisioned provider fails closed.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 240_000 });
import { ForbiddenError } from "@/platform/authz";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import {
  cancelSignatureRequest,
  createDocument,
  createSignatureRequest,
  declineWithToken,
  getDocument,
  getRevision,
  getSignatureProvider,
  getSignatureRequest,
  issueDocument,
  listSignaturesForRender,
  resolveSignerToken,
  revokeSigner,
  saveRevision,
  signAsMember,
  signWithToken,
} from "@/modules/docstudio/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
const userM = randomUUID();
let orgA = "";
const ctxOf = (userId: string): Ctx => ({
  orgId: orgA,
  userId,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h26f",
});
const A = () => ctxOf(userA);
const M = () => ctxOf(userM);
const info = { ip: "203.0.113.5", userAgent: "vitest" };

async function issuedNda(title: string): Promise<string> {
  const d = await createDocument(A(), "owner", {
    title,
    builtinKey: "builtin.nda",
    language: "en",
  });
  const rev = await getRevision(A(), "owner", d.revisionId);
  await saveRevision(A(), "owner", {
    documentId: d.id,
    revisionId: d.revisionId,
    expectedRowVersion: rev.rowVersion,
    variables: { term_years: 2 },
  });
  const r = await issueDocument(A(), "owner", { documentId: d.id });
  expect(r.status).toBe("signature");
  return d.id;
}

beforeAll(async () => {
  for (const [id, name] of [
    [userA, "Owner"],
    [userM, "Manager"],
  ] as const) {
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h26f-${name.toLowerCase()}-${run}@example.invalid`},
              ${JSON.stringify({ full_name: name })}::jsonb, now(), now())`;
  }
  orgA = await createOrgForUser(userA, { name: "H26F", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h26f", run);
  await owner`
    insert into public.user_profile (id, full_name, locale) values (${userM}, 'Manager', 'en')
    on conflict (id) do nothing`;
  await owner`
    insert into public.membership (user_id, org_id, role_key) values (${userM}, ${orgA}, 'manager')`;
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA, userM]);
  await owner.end();
  await closeAppDb();
});

describe("the signature room", () => {
  let docId = "";
  let externalToken = "";
  let memberSignerId = "";

  it("opens only on an issued document with a signer per party; invitations are hashed and single use", async () => {
    docId = await issuedNda(`NDA ${run}`);
    await expect(
      createSignatureRequest(A(), "owner", {
        documentId: docId,
        signers: [{ party: "company", kind: "member", userId: userM, name: "Manager" }],
      }),
    ).rejects.toMatchObject({ code: "validation" }); // counterparty missing
    const r = await createSignatureRequest(A(), "owner", {
      documentId: docId,
      mode: "parallel",
      signers: [
        { party: "company", kind: "member", userId: userM, name: "Manager", title: "Director" },
        {
          party: "counterparty",
          kind: "external",
          name: "Maha Saleh",
          email: `maha-${run}@example.invalid`,
        },
      ],
    });
    expect(r.invitations.length).toBe(2);
    const ext = r.invitations.find((i) => i.name === "Maha Saleh")!;
    // No email provider on the test box → the link comes back ONCE (delivery = link).
    expect(ext.delivery).toBe("link");
    expect(ext.link).toMatch(/\/sign\/[A-Za-z0-9_-]{40,}$/);
    externalToken = ext.link!.split("/sign/")[1]!;
    const stored = (await owner`
      select token_hash from public.doc_signer where id = ${ext.signerId}`) as unknown as Array<{
      token_hash: string;
    }>;
    expect(stored[0]!.token_hash).toBe(createHash("sha256").update(externalToken).digest("hex"));
    expect(stored[0]!.token_hash).not.toBe(externalToken);
    const req = await getSignatureRequest(A(), "owner", docId);
    expect(req?.status).toBe("in_progress");
    memberSignerId = req!.signers.find((s) => s.partyKind === "member")!.id;
    expect(req!.signers.find((s) => s.partyKind === "member")?.delivery).toBe("in_app");
    // A second live room is refused by the partial unique index.
    await expect(
      createSignatureRequest(A(), "owner", {
        documentId: docId,
        signers: [
          { party: "company", kind: "member", userId: userM, name: "Manager" },
          { party: "counterparty", kind: "external", name: "X", email: "x@example.invalid" },
        ],
      }),
    ).rejects.toThrow();
  });

  it("a member signs only their own party, in-app", async () => {
    const capture = {
      kind: "typed" as const,
      data: "Manager",
      name: "Manager",
      consent: true as const,
      locale: "en" as const,
    };
    await expect(
      signAsMember(A(), "owner", { signerId: memberSignerId, capture }, info),
    ).rejects.toMatchObject({ code: "forbidden" });
    const res = await signAsMember(M(), "manager", { signerId: memberSignerId, capture }, info);
    expect(res.completed).toBe(false);
    expect(res.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    // Signed rows are immutable even for the owner connection.
    await expect(
      owner`update public.doc_signer set name = 'x' where id = ${memberSignerId}`,
    ).rejects.toThrow(/immutable/);
    const req = await getSignatureRequest(A(), "owner", docId);
    const s = req!.signers.find((x) => x.id === memberSignerId)!;
    expect(s.status).toBe("signed");
    expect((s.evidence as { verifiedVia: string }).verifiedVia).toBe("member_session");
  });

  it("an external signer signs through the resolver; the last signature activates the document", async () => {
    const resolved = await resolveSignerToken(externalToken);
    expect(resolved?.party).toBe("counterparty");
    expect(await resolveSignerToken("not-a-real-token-value-at-all-1234567890")).toBeNull();
    const res = await signWithToken(
      resolved!,
      {
        kind: "drawn",
        data: "M10 60 L120 40 Q160 20 200 60 L390 50",
        name: "Maha Saleh",
        title: "Owner",
        consent: true,
        locale: "ar",
      },
      info,
    );
    expect(res.completed).toBe(true);
    // The token is dead now.
    expect(await resolveSignerToken(externalToken)).toBeNull();
    await expect(
      signWithToken(
        resolved!,
        { kind: "typed", data: "Maha", name: "Maha", consent: true, locale: "en" },
        info,
      ),
    ).rejects.toMatchObject({
      code: "state",
    });
    const d = await getDocument(A(), "owner", docId);
    expect(d.document.status).toBe("active");
    expect(d.chain).toEqual({ ok: true });
    const kinds = d.events.map((e) => e.kind);
    expect(kinds).toContain("signature_requested");
    expect(kinds).toContain("invitation_sent");
    expect(kinds.filter((k) => k === "signed").length).toBe(2);
    expect(kinds).toContain("activated");
    const signedEvent = d.events.find(
      (e) => e.kind === "signed" && e.actorLabel?.includes("Maha"),
    )!;
    expect(signedEvent.actorUserId).toBeNull();
    expect((signedEvent.payload as { evidenceHash: string }).evidenceHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
    const render = await listSignaturesForRender(A(), "owner", docId, "en");
    expect(render.rows.filter((r) => r.signedAt !== null).length).toBe(2);
    expect(render.evidenceLines.some((l) => l.includes("Maha Saleh signed at"))).toBe(true);
    expect(render.evidenceLines.some((l) => /no digital certificate/i.test(l))).toBe(true);
  });

  it("revocation kills a token; decline closes the request; cancel retires everything", async () => {
    const doc2 = await issuedNda(`NDA two ${run}`);
    const r = await createSignatureRequest(A(), "owner", {
      documentId: doc2,
      mode: "sequential",
      signers: [
        {
          party: "company",
          kind: "external",
          name: "First",
          email: `first-${run}@example.invalid`,
        },
        {
          party: "counterparty",
          kind: "external",
          name: "Second",
          email: `second-${run}@example.invalid`,
        },
      ],
    });
    // Sequential: only the first signer is invited now.
    expect(r.invitations.length).toBe(1);
    const t1 = r.invitations[0]!.link!.split("/sign/")[1]!;
    expect(await resolveSignerToken(t1)).not.toBeNull();
    await revokeSigner(A(), "owner", {
      signerId: r.invitations[0]!.signerId,
      reason: "wrong person",
    });
    expect(await resolveSignerToken(t1)).toBeNull();
    // Cancel the whole request.
    await cancelSignatureRequest(A(), "owner", { requestId: r.id, reason: "restart" });
    expect((await getSignatureRequest(A(), "owner", doc2))?.status).toBe("cancelled");
    // A fresh room; the external signer declines.
    const r2 = await createSignatureRequest(A(), "owner", {
      documentId: doc2,
      signers: [
        { party: "company", kind: "member", userId: userA, name: "Owner" },
        {
          party: "counterparty",
          kind: "external",
          name: "Second",
          email: `second-${run}@example.invalid`,
        },
      ],
    });
    const t2 = r2.invitations.find((i) => i.name === "Second")!.link!.split("/sign/")[1]!;
    await declineWithToken((await resolveSignerToken(t2))!, { reason: "terms unacceptable" }, info);
    expect((await getSignatureRequest(A(), "owner", doc2))?.status).toBe("declined");
    expect((await getDocument(A(), "owner", doc2)).document.status).toBe("signature");
    expect((await getDocument(A(), "owner", doc2)).events.map((e) => e.kind)).toContain("declined");
  });

  it("an unprovisioned provider fails closed with the owner action", () => {
    expect(() => getSignatureProvider("uae_pass")).toThrow(/not provisioned/);
    expect(() => getSignatureProvider("uae_pass")).toThrow(/Owner action/);
    expect(getSignatureProvider("native").capabilities.legalLevel).toBe("electronic");
  });

  it("a manager without documents.issue cannot open a room", async () => {
    const doc3 = await issuedNda(`NDA three ${run}`);
    await expect(
      createSignatureRequest(M(), "viewer", {
        documentId: doc3,
        signers: [{ party: "company", kind: "member", userId: userM, name: "M" }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
