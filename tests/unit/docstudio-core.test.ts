/**
 * H26A — the pure core of the Document Studio: the block vocabulary, the
 * canonical hash and evidence chain, the safe expression evaluator, the
 * condition evaluator, revision diffs and the renderer's escaping.
 */
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_TEMPLATES,
  DocBody,
  GENESIS_HASH,
  bodyPlainText,
  canonicalJson,
  contentHash,
  diffRevisions,
  evaluateConditions,
  evaluateExpression,
  renderBody,
  renderDocumentHtml,
  signatureParties,
  verifyChain,
  visibleBlocks,
  wordDiff,
  type ResolvedValues,
} from "@/modules/docstudio/service";
import { eventHash } from "@/modules/docstudio/snapshot";
import { DEFAULT_SETTINGS } from "@/modules/docstudio/types";

const values = (v: Partial<ResolvedValues> = {}): ResolvedValues => ({
  bindings: {},
  lineItems: {},
  variables: {},
  ...v,
});

describe("block vocabulary", () => {
  it("every built-in template is a valid body with unique ids and keys", () => {
    for (const t of BUILT_IN_TEMPLATES) {
      expect(() => DocBody.parse(t.body), t.key).not.toThrow();
      expect(t.nameAr.length).toBeGreaterThan(0);
    }
    expect(BUILT_IN_TEMPLATES.length).toBe(6);
  });

  it("rejects duplicate block ids, duplicate field keys and choice fields without options", () => {
    const dup = DocBody.safeParse({
      blocks: [
        { id: "a", type: "paragraph", text: { en: "x" } },
        { id: "a", type: "paragraph", text: { en: "y" } },
      ],
    });
    expect(dup.success).toBe(false);
    const keys = DocBody.safeParse({
      blocks: [
        { id: "f1", type: "field", key: "k", kind: "text", label: { en: "a" } },
        { id: "f2", type: "field", key: "k", kind: "text", label: { en: "b" } },
      ],
    });
    expect(keys.success).toBe(false);
    const choice = DocBody.safeParse({
      blocks: [{ id: "f1", type: "field", key: "k", kind: "choice", label: { en: "a" } }],
    });
    expect(choice.success).toBe(false);
  });

  it("refuses unknown block types, unknown binding paths and empty text", () => {
    expect(
      DocBody.safeParse({ blocks: [{ id: "x", type: "script", text: { en: "a" } }] }).success,
    ).toBe(false);
    expect(
      DocBody.safeParse({ blocks: [{ id: "x", type: "binding", path: "customer.password" }] })
        .success,
    ).toBe(false);
    expect(DocBody.safeParse({ blocks: [{ id: "x", type: "paragraph", text: {} }] }).success).toBe(
      false,
    );
  });

  it("signature parties are read from the body in order", () => {
    const nda = BUILT_IN_TEMPLATES.find((t) => t.key === "builtin.nda")!;
    expect(signatureParties(nda.body)).toEqual(["company", "counterparty"]);
    expect(bodyPlainText(nda.body)).toContain("Confidential information");
  });
});

describe("canonical hashing and the evidence chain", () => {
  it("canonical JSON is key-order independent and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [{ z: 1, y: undefined }] })).toBe('{"a":[{"z":1}],"b":1}');
    expect(contentHash({ b: 1, a: 2 })).toBe(contentHash({ a: 2, b: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a chain verifies, and any edit, reorder or gap is detected", () => {
    const mk = (seq: number, prev: string, kind: string) => {
      const e = {
        documentId: "d",
        seq,
        kind,
        actorUserId: "u",
        actorLabel: null,
        payload: { seq },
        at: `2026-09-02T00:00:0${seq}.000Z`,
      };
      return { ...e, prevHash: prev, eventHash: eventHash(prev, e) };
    };
    const e1 = mk(1, GENESIS_HASH, "created");
    const e2 = mk(2, e1.eventHash, "issued");
    const e3 = mk(3, e2.eventHash, "signed");
    expect(verifyChain([e1, e2, e3])).toEqual({ ok: true });
    expect(verifyChain([e1, { ...e2, kind: "terminated" }, e3])).toMatchObject({
      ok: false,
      atSeq: 2,
    });
    expect(verifyChain([e1, e3])).toMatchObject({ ok: false, atSeq: 3, reason: "sequence gap" });
    expect(verifyChain([e1, { ...e2, prevHash: GENESIS_HASH }, e3])).toMatchObject({
      ok: false,
      atSeq: 2,
    });
    expect(verifyChain([])).toEqual({ ok: true });
  });
});

describe("expressions", () => {
  it("evaluates arithmetic over field keys without eval", () => {
    expect(evaluateExpression("qty * price + 10", { qty: 3, price: "2.5" })).toBe(17.5);
    expect(evaluateExpression("round(amount * 0.05, 2)", { amount: 1234.567 })).toBe(61.73);
    expect(evaluateExpression("max(a, b) - min(a, b)", { a: 2, b: 9 })).toBe(7);
    expect(evaluateExpression("sum(1, 2, 3) / 0", {})).toBe(0);
    expect(evaluateExpression("-(2 + 3) * missing", {})).toBe(-0);
  });

  it("refuses anything that is not arithmetic", () => {
    for (const bad of ["a.b", "process()", "1 +", "x = 2", "'s'", "a[0]", "fetch(1)"]) {
      expect(() => evaluateExpression(bad, {}), bad).toThrow();
    }
  });
});

describe("conditions", () => {
  const v = values({
    bindings: { "document.amount": "60000.00", "counterparty.country": "AE" },
    variables: { customer_type: 0, consent: true, notes: "" },
  });
  it("compares numerically when both sides are numbers, else as strings", () => {
    expect(evaluateConditions({ key: "document.amount", op: "gte", value: 50000 }, v)).toBe(true);
    expect(evaluateConditions({ key: "document.amount", op: "lt", value: 50000 }, v)).toBe(false);
    expect(evaluateConditions({ key: "counterparty.country", op: "eq", value: "ae" }, v)).toBe(
      true,
    );
    expect(
      evaluateConditions({ key: "counterparty.country", op: "in", value: ["SA", "AE"] }, v),
    ).toBe(true);
    expect(evaluateConditions({ key: "customer_type", op: "eq", value: 0 }, v)).toBe(true);
    expect(evaluateConditions({ key: "consent", op: "truthy" }, v)).toBe(true);
    expect(evaluateConditions({ key: "notes", op: "empty" }, v)).toBe(true);
    expect(evaluateConditions({ key: "nothing", op: "not_empty" }, v)).toBe(false);
  });
  it("combines with all / any / not", () => {
    expect(
      evaluateConditions(
        {
          all: [
            { key: "consent", op: "truthy" },
            { not: { key: "customer_type", op: "eq", value: 1 } },
          ],
        },
        v,
      ),
    ).toBe(true);
    expect(
      evaluateConditions(
        {
          any: [
            { key: "notes", op: "not_empty" },
            { key: "document.amount", op: "gt", value: 1 },
          ],
        },
        v,
      ),
    ).toBe(true);
  });
  it("hides conditional sections whose condition fails", () => {
    const sa = BUILT_IN_TEMPLATES.find((t) => t.key === "builtin.service_agreement")!;
    const low = visibleBlocks(sa.body, values({ bindings: { "document.amount": "1000.00" } }));
    const high = visibleBlocks(sa.body, values({ bindings: { "document.amount": "80000.00" } }));
    expect(low.some((b) => b.id === "deposit_section")).toBe(false);
    expect(high.some((b) => b.id === "deposit_section")).toBe(true);
  });
});

describe("diff", () => {
  it("reports added, removed, changed (with words) and moved blocks", () => {
    const before = DocBody.parse({
      blocks: [
        { id: "a", type: "paragraph", text: { en: "The quick brown fox" } },
        { id: "b", type: "paragraph", text: { en: "second" } },
        { id: "c", type: "paragraph", text: { en: "third" } },
      ],
    });
    const after = DocBody.parse({
      blocks: [
        { id: "c", type: "paragraph", text: { en: "third" } },
        { id: "a", type: "paragraph", text: { en: "The slow brown fox" } },
        { id: "d", type: "paragraph", text: { en: "new" } },
      ],
    });
    const d = diffRevisions(before, after);
    expect(d.summary).toMatchObject({ added: 1, removed: 1, changed: 1 });
    const changed = d.changes.find((c) => c.kind === "changed");
    expect(
      changed &&
        changed.kind === "changed" &&
        changed.words?.en?.some((w) => w.op === "del" && w.text === "quick"),
    ).toBe(true);
    expect(wordDiff("a b c", "a x c").map((w) => w.op)).toEqual(["eq", "del", "ins", "eq"]);
  });
});

describe("renderer", () => {
  const issuer = {
    tradingName: "Acme",
    legalName: "Acme LLC",
    trn: "100000000000003",
    licenseNo: null,
    addressLineEn: "Dubai",
    addressLineAr: "دبي",
    phone: null,
    email: null,
    website: null,
    footer: null,
    signatoryName: null,
    signatoryTitle: null,
    paymentInstructions: null,
    logoDataUri: null,
  };
  it("escapes text, interpolates values, numbers clauses and marks unavailable bindings", () => {
    const body = DocBody.parse({
      blocks: [
        { id: "p", type: "paragraph", text: { en: "Hello <b>{{name}}</b> **bold**" } },
        { id: "c1", type: "clause", text: { en: "one" } },
        { id: "c2", type: "clause", text: { en: "two" } },
        { id: "b", type: "binding", path: "counterparty.trn" },
      ],
    });
    const html = renderBody({
      language: "en",
      body,
      settings: DEFAULT_SETTINGS,
      values: values({ variables: { name: "Al<i>i" }, bindings: { "counterparty.trn": null } }),
      issuer,
      reference: "DOC-001",
      title: "T",
      dateText: "today",
      statusText: "Draft",
    });
    expect(html).toContain("Hello &lt;b&gt;Al&lt;i&gt;i&lt;/b&gt; <strong>bold</strong>");
    expect(html).toContain('<span class="ds-clause-no"><bdi dir="ltr">1</bdi></span>');
    expect(html).toContain('<span class="ds-clause-no"><bdi dir="ltr">2</bdi></span>');
    expect(html).toContain("[not available]");
    expect(html).not.toContain("<b>");
  });
  it("renders bilingual documents with both languages and an RTL shell", () => {
    const nda = BUILT_IN_TEMPLATES.find((t) => t.key === "builtin.nda")!;
    const html = renderDocumentHtml({
      language: "bilingual",
      body: nda.body,
      settings: DEFAULT_SETTINGS,
      values: values({ variables: { term_years: 2 } }),
      issuer,
      reference: "DOC-001",
      title: "NDA",
      dateText: "today",
      statusText: "Draft",
    });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="ar"');
    expect(html).toContain("اتفاقية عدم إفصاح");
    expect(html).toContain("Mutual non-disclosure agreement");
    expect(html).toContain("Not yet signed");
    expect(html).toContain("لم يُوقَّع بعد");
  });
  it("renders line items with totals in minor units", () => {
    const body = DocBody.parse({
      blocks: [
        {
          id: "l",
          type: "line_items",
          source: "manual",
          currency: "AED",
          items: [
            {
              description: { en: "Widget" },
              qty: 2,
              unit: "pc",
              unitPriceMinor: 10050,
              vatRate: 5,
            },
          ],
          showVat: true,
          showTotals: true,
        },
      ],
    });
    const html = renderBody({
      language: "en",
      body,
      settings: DEFAULT_SETTINGS,
      values: values(),
      issuer,
      reference: "DOC-002",
      title: "T",
      dateText: "today",
      statusText: "Draft",
    });
    expect(html).toContain("Widget");
    expect(html).toMatch(/201\.00/); // subtotal 2 × 100.50
    expect(html).toMatch(/10\.05/); // VAT 5%
    expect(html).toMatch(/211\.05/); // total
  });
});

describe("issue-time visibility", () => {
  it("keeps sections gated on party-filled answers and prunes issuer-decided ones", () => {
    const body = DocBody.parse({
      blocks: [
        {
          id: "f1",
          type: "field",
          key: "kind",
          kind: "choice",
          label: { en: "Kind" },
          required: true,
          filledBy: "party",
          party: "respondent",
          options: [{ en: "A" }, { en: "B" }],
        },
        {
          id: "s1",
          type: "section",
          title: { en: "Only for A" },
          condition: { key: "kind", op: "eq", value: 0 },
          blocks: [
            {
              id: "f2",
              type: "field",
              key: "extra",
              kind: "text",
              label: { en: "Extra" },
              required: false,
              filledBy: "party",
              party: "respondent",
            },
          ],
        },
        {
          id: "s2",
          type: "section",
          title: { en: "Deposit" },
          condition: { key: "document.amount", op: "gte", value: 50000 },
          blocks: [],
        },
      ],
    });
    const out = visibleBlocks(body, values({}));
    expect(out.map((b) => b.id)).toEqual(["f1", "s1"]);
    const withAmount = visibleBlocks(body, values({ bindings: { "document.amount": "60000" } }));
    expect(withAmount.map((b) => b.id)).toEqual(["f1", "s1", "s2"]);
  });
});
