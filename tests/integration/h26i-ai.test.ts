/**
 * H26I — the assistant seam on the TEST project: with the production default
 * (no provider) every call fails closed with the owner action and nothing is
 * written; with a deterministic provider injected, answers cite only clauses
 * that exist, an answer without valid citations says evidence was not found,
 * proposals are returned without creating anything, and a viewer can use it
 * read-only while a foreman cannot.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 240_000 });
import { ForbiddenError } from "@/platform/authz";
import { DeterministicTestProvider } from "@/platform/agents";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { createOrgForUser } from "@/platform/auth/identity";
import { installTemplate, TEMPLATE_BOATBUILDING } from "@/platform/config";
import {
  aiAvailability,
  askDocument,
  createDocument,
  listObligations,
  proposeObligations,
  summariseDocument,
} from "@/modules/docstudio/service";
import { markFixtureOrg, ownerSql, wipeOrgs } from "./helpers";

const owner = ownerSql();
const run = randomUUID().slice(0, 8);
const userA = randomUUID();
let orgA = "";
const A = (): Ctx => ({
  orgId: orgA,
  userId: userA,
  costPrivileged: true,
  pricePrivileged: true,
  requestId: "h26i",
});

beforeAll(async () => {
  await owner`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${userA}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`h26i-owner-${run}@example.invalid`}, '{"full_name":"Owner"}'::jsonb, now(), now())`;
  orgA = await createOrgForUser(userA, { name: "H26I", country: "AE", baseCurrency: "AED" });
  await markFixtureOrg(owner, orgA, "h26i", run);
  await installTemplate(A(), TEMPLATE_BOATBUILDING.key);
}, 600_000);

afterAll(async () => {
  await wipeOrgs(owner, [orgA], [userA]);
  await owner.end();
  await closeAppDb();
});

describe("assistant seam", () => {
  let docId = "";
  it("fails closed by default with the exact owner action; nothing is written", async () => {
    const d = await createDocument(A(), "owner", {
      title: `Refit ${run}`,
      category: "contract",
      language: "en",
      body: {
        blocks: [
          { id: "h1", type: "heading", level: 1, text: { en: "Refit terms" } },
          {
            id: "c1",
            type: "clause",
            title: { en: "Payment" },
            text: { en: "The customer pays 30 percent on signature and the balance on delivery." },
          },
          {
            id: "c2",
            type: "clause",
            title: { en: "Term" },
            text: { en: "This agreement runs for twelve months." },
          },
        ],
      },
    });
    docId = d.id;
    const avail = await aiAvailability(A());
    expect(avail.available).toBe(false);
    expect(avail.provider).toBe("disabled");
    expect(avail.ownerAction).toContain("getAgentProvider");
    await expect(
      askDocument(A(), "owner", { documentId: docId, question: "When is payment due?" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(summariseDocument(A(), "owner", docId)).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(proposeObligations(A(), "owner", docId)).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("with a provider: citations are validated, no evidence is honest, proposals persist nothing", async () => {
    const provider = DeterministicTestProvider((req) => {
      expect(req.consultedToolIds).toEqual(["read.document_text"]);
      expect(req.context[0]!.content).toContain("[c1]");
      if (req.input.includes("Summarise"))
        return {
          output: {
            summary: "A refit agreement with staged payment.",
            keyTerms: ["30 percent deposit", "12 months"],
          },
        };
      if (req.input.includes("List the obligations"))
        return {
          output: {
            proposals: [
              {
                title: "Collect 30 percent deposit",
                kind: "payment",
                dueOn: null,
                clauseId: "c1",
                rationale: "Clause 1",
              },
              { title: "Made-up item", kind: "notice", clauseId: "zzz" },
            ],
          },
        };
      if (req.input.includes("unknown"))
        return { output: { answer: "Something invented.", citations: [{ blockId: "nope" }] } };
      return {
        output: {
          answer: "30 percent on signature and the balance on delivery.",
          citations: [{ blockId: "c1", excerpt: "30 percent on signature" }, { blockId: "ghost" }],
        },
      };
    });
    const deps = { provider, enabled: true };
    const s = await summariseDocument(A(), "owner", docId, deps);
    expect(s.keyTerms.length).toBe(2);
    expect(s.notice).toContain("Not legal advice");
    const a = await askDocument(
      A(),
      "owner",
      { documentId: docId, question: "When is payment due?" },
      deps,
    );
    expect(a.evidenceFound).toBe(true);
    expect(a.citations.map((c) => c.blockId)).toEqual(["c1"]);
    expect(a.citations[0]!.ref).toBe("clause 1");
    const none = await askDocument(
      A(),
      "owner",
      { documentId: docId, question: "unknown thing?" },
      deps,
    );
    expect(none.evidenceFound).toBe(false);
    expect(none.answer).toBe("Evidence was not found in this document.");
    expect(none.citations).toEqual([]);
    const props = await proposeObligations(A(), "owner", docId, deps);
    expect(props.length).toBe(2);
    expect(props[0]!.clauseRef).toBe("clause 1");
    expect(props[1]!.clauseId).toBeNull();
    // Nothing was created: the document is a draft and has no obligations.
    expect(await listObligations(A(), "owner", { documentId: docId })).toEqual([]);
    // A foreman has no documents.view: the seam refuses before any read.
    await expect(
      askDocument(A(), "foreman", { documentId: docId, question: "x?" }, deps),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
