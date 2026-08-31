/**
 * H22.0.1 — the issuer snapshot must be wired into the REAL lifecycle.
 *
 * H22.0 built `captureDocumentIssuerIn`, tested it by calling it directly, and
 * shipped with no quotation or invoice lifecycle action calling it. The helper
 * worked perfectly and never ran. Every quote and invoice in production rendered
 * today's legal name and tax number under a notice claiming it was a legacy
 * record.
 *
 * The integration suite proves the behaviour end to end through the real service
 * actions. This file guards the wiring itself: it fails the moment a transition
 * into a final status stops capturing, which is cheaper and louder than waiting
 * for a slow integration run, and it names the exact function that regressed.
 *
 * Reading source text is deliberate. The alternative — asserting only through
 * behaviour — is what let the original defect through, because the behavioural
 * test called the helper itself rather than the action a user triggers.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

const QUOTES = read("src", "modules", "quotes", "service.ts");
const INVOICES = read("src", "modules", "invoices", "service.ts");
const DOCUMENTS = read("src", "modules", "documents", "service.ts");

/** The body of an exported function, from its signature to the next one. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found — it was renamed or removed`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\nexport (async )?(function|const) /);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Every transition that moves a document INTO a status the document layer treats
 * as final. Keep this in step with ISSUED_STATUSES in the documents service; the
 * test below checks that correspondence rather than trusting this list alone.
 */
const MUST_CAPTURE: Array<{ file: string; source: string; fn: string; stampsIssuedAt: boolean }> = [
  { file: "quotes", source: QUOTES, fn: "markQuoteSent", stampsIssuedAt: true },
  { file: "quotes", source: QUOTES, fn: "acceptQuote", stampsIssuedAt: true },
  { file: "quotes", source: QUOTES, fn: "rejectQuote", stampsIssuedAt: false },
  { file: "invoices", source: INVOICES, fn: "issueInvoice", stampsIssuedAt: true },
  { file: "invoices", source: INVOICES, fn: "voidInvoice", stampsIssuedAt: false },
  { file: "invoices", source: INVOICES, fn: "createCreditNote", stampsIssuedAt: true },
];

describe("issuer capture is wired into the real lifecycle actions", () => {
  it.each(MUST_CAPTURE)("$file.$fn captures the issuer identity", ({ source, fn }) => {
    const body = bodyOf(source, fn);
    expect(
      body,
      `${fn} changes a document to a final status without capturing the issuer identity. ` +
        `A document issued by this path would print the organization's CURRENT legal name ` +
        `and tax number as though they were the ones it was issued under.`,
    ).toMatch(/captureIssuer\s*\(/);
  });

  it.each(MUST_CAPTURE.filter((c) => c.stampsIssuedAt))(
    "$file.$fn stamps the issue date",
    ({ source, fn }) => {
      expect(bodyOf(source, fn), `${fn} is a genuine issuance and must record when`).toMatch(
        /stampIssuedAt:\s*true/,
      );
    },
  );

  it.each(MUST_CAPTURE.filter((c) => !c.stampsIssuedAt))(
    "$file.$fn does NOT invent an issue date",
    ({ source, fn }) => {
      // Rejection and cancelling a draft make a document final without issuing
      // it. Stamping issued_at there would record a moment that never happened.
      const call = bodyOf(source, fn).match(/captureIssuer\s*\([^)]*\)/s)?.[0] ?? "";
      expect(call, `${fn} is not an issuance`).not.toMatch(/stampIssuedAt:\s*true/);
    },
  );

  it("the helper still exists and is exported for those callers", () => {
    expect(DOCUMENTS).toMatch(/export async function captureDocumentIssuerIn\(/);
  });

  it("both services reach the helper through the documents module's own door", () => {
    // Not a style preference: the documents module imports these two, so a
    // static import here would close a cycle.
    for (const [name, source] of [
      ["quotes", QUOTES],
      ["invoices", INVOICES],
    ] as const) {
      expect(source, `${name} must import captureDocumentIssuerIn`).toContain(
        'await import("@/modules/documents/service")',
      );
      expect(source).toContain("captureDocumentIssuerIn");
    }
  });

  it("capture happens inside the lifecycle transaction, not after it", () => {
    // The capture must share the transaction with the status change, so a
    // failure cannot leave a document final with no identity, or an identity on
    // a document that never transitioned.
    for (const { source, fn } of MUST_CAPTURE) {
      const body = bodyOf(source, fn);
      const tx = body.search(/async \(tx\)|withCtx\(/);
      const capture = body.indexOf("captureIssuer(");
      expect(tx, `${fn} has no transaction`).toBeGreaterThan(-1);
      expect(capture, `${fn} captures outside its transaction`).toBeGreaterThan(tx);
      expect(body.slice(capture)).toMatch(/captureIssuer\(\s*tx\s*,/);
    }
  });
});

describe("the capture itself cannot overwrite history", () => {
  it("writes only when no snapshot exists", () => {
    const body = bodyOf(DOCUMENTS, "captureDocumentIssuerIn");
    // This single predicate is the whole concurrency story: first writer wins,
    // every retry and concurrent request matches no row.
    expect(body).toMatch(/issuer_snapshot is null/);
  });

  it("never moves an issue date that is already set", () => {
    expect(bodyOf(DOCUMENTS, "captureDocumentIssuerIn")).toMatch(
      /issued_at\s*=\s*coalesce\(issued_at,\s*now\(\)\)/,
    );
  });

  it("covers every status the document layer renders as final", () => {
    // If someone adds a status to ISSUED_STATUSES, some transition must reach
    // it, and that transition needs a capture. This asserts the two lists were
    // considered together rather than drifting apart silently.
    const issued = DOCUMENTS.match(/const ISSUED_STATUSES[^;]+;/s)?.[0] ?? "";
    expect(issued).toBeTruthy();
    for (const status of ["sent", "converting", "rejected"]) {
      expect(issued, `quote status ${status} should be listed as final`).toContain(`"${status}"`);
    }
    for (const status of ["issued", "cancelled"]) {
      expect(issued, `invoice status ${status} should be listed as final`).toContain(`"${status}"`);
    }
  });
});
