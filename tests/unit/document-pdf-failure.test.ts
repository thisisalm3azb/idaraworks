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
