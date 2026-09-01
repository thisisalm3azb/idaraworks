/**
 * H22F — a document that cannot be PRINTED is not a document that is MISSING.
 *
 * Both document routes used to answer every error with 404 "not found". In
 * production the PDF renderer could not start at all (the browser binary was
 * never traced into the function), so every Download PDF told the reader their
 * document did not exist — which, for somebody looking at their own invoice, is
 * the most alarming possible way to report a server problem.
 *
 * These tests pin the distinction, because it is the sort that quietly collapses
 * back into a single catch-all the next time somebody tidies the error handling.
 */
import { describe, expect, it } from "vitest";
import {
  isRenderFailure,
  pdfUnavailablePage,
  renderUnavailable,
} from "@/platform/documents/failure";

describe("telling a broken renderer from a missing document", () => {
  it("recognises the ways the renderer actually fails", () => {
    const renderFailures = [
      Object.assign(new Error("too many documents are rendering at once"), {
        name: "PdfBusyError",
      }),
      new Error("The input directory does not exist: /var/task/bin"),
      new Error("ENOENT: no such file or directory, open '/tmp/chromium'"),
      new Error("browserType.launch: Executable doesn't exist at /tmp/chromium"),
      new Error("Failed to launch the browser process"),
      new Error("Target closed"),
      new Error("Protocol error (Page.printToPDF): Target closed"),
      new Error("Timeout 30000ms exceeded"),
    ];
    for (const err of renderFailures) {
      expect(isRenderFailure(err), err.message).toBe(true);
    }
  });

  it("does NOT claim a lookup failure is a renderer problem", () => {
    /*
     * The narrow direction matters more than the wide one. A record in another
     * organization must keep answering 404 — telling the caller "the renderer is
     * down" for an id that exists elsewhere would confirm it exists.
     */
    const notRenderFailures = [
      new Error("no rows returned"),
      new Error("invoice not found"),
      new Error("permission denied for table invoice"),
      new Error("invalid input syntax for type uuid"),
      "a string, not an error",
      null,
      undefined,
    ];
    for (const err of notRenderFailures) {
      expect(isRenderFailure(err), String(err)).toBe(false);
    }
  });

  it("the recipient's page says the document is fine and links back to it", () => {
    const html = pdfUnavailablePage("/d/abc?lang=en");
    // The first thing anybody assumes when a download fails is that their data
    // is gone. The page has to answer that before anything else.
    expect(html).toContain("The document is fine");
    expect(html).toContain("/d/abc?lang=en");
    // And it names the way out that always works, because it uses their browser.
    expect(html.toLowerCase()).toContain("print");
    expect(html).toContain("<!doctype html>");
  });

  it("answers a browser with a page and a script with JSON", async () => {
    /*
     * Download PDF is a plain link on purpose — middle-click, keyboard, new tab
     * — and a link NAVIGATES. A JSON body would land a person on a page of raw
     * JSON and leave them to interpret it.
     */
    const err = new Error("The input directory does not exist: /var/task/bin");
    const toBrowser = renderUnavailable(err, "/doc?print=1", "text/html,application/xhtml+xml");
    expect(toBrowser.status).toBe(503);
    expect(toBrowser.headers.get("content-type")).toContain("text/html");
    expect(await toBrowser.text()).toContain("The document is fine");

    const toScript = renderUnavailable(err, "/doc?print=1", "application/json");
    expect(toScript.status).toBe(503);
    expect(toScript.headers.get("content-type")).toContain("application/json");
    const body = (await toScript.json()) as { error: string; printUrl: string };
    expect(body.error).toBe("pdf_unavailable");
    expect(body.printUrl, "and it names the way out").toBe("/doc?print=1");
  });
});

/**
 * The wrapper, which replaced the matcher as the thing routes actually rely on.
 *
 * The matcher shipped, and production went on answering 404 for a document that
 * plainly existed, because the error it really threw was not on the list. That
 * is the permanent weakness of a substring list: it can only hold failures
 * somebody already imagined, and the one that reaches production is the one
 * nobody did. These tests are written to fail if anybody swaps position-based
 * detection back for pattern matching.
 */
describe("a failure is judged by where it happened, not by what it says", () => {
  it("marks anything thrown inside the render, however unfamiliar", async () => {
    const { renderingPdf, isRenderFailure } = await import("@/platform/documents/failure");
    // Deliberately a message no matcher would ever recognise.
    const alien = new Error("quota exceeded for resource type 42");
    await expect(
      renderingPdf(async () => {
        throw alien;
      }),
    ).rejects.toMatchObject({ name: "PdfRenderError" });

    let caught: unknown;
    try {
      await renderingPdf(async () => {
        throw alien;
      });
    } catch (e) {
      caught = e;
    }
    expect(isRenderFailure(caught), "an unrecognised render error is still a render error").toBe(
      true,
    );
    expect((caught as Error).cause, "the original is kept for the log").toBe(alien);
  });

  it("passes a success straight through", async () => {
    const { renderingPdf } = await import("@/platform/documents/failure");
    await expect(renderingPdf(async () => "pdf-bytes")).resolves.toBe("pdf-bytes");
  });

  it("does not double-wrap", async () => {
    const { renderingPdf, PdfRenderError } = await import("@/platform/documents/failure");
    const inner = new PdfRenderError(new Error("first"));
    let caught: unknown;
    try {
      await renderingPdf(async () => {
        throw inner;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught, "wrapping twice would bury the original cause").toBe(inner);
  });

  it("leaves a lookup failure OUTSIDE the wrapper still a 404", async () => {
    /*
     * The direction that matters most. A record in another organization must
     * keep answering "not found" — the wrapper must be placed around the render
     * only, never around the lookup, or a tenancy probe learns that an id exists
     * somewhere.
     */
    const { isRenderFailure } = await import("@/platform/documents/failure");
    expect(isRenderFailure(new Error("no rows returned"))).toBe(false);
    expect(isRenderFailure(new Error("permission denied for table quote"))).toBe(false);
  });
});
