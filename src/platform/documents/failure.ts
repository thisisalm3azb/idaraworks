/**
 * Telling a rendering failure apart from a missing document (H22F).
 *
 * Both document routes used to answer every error with 404 "not found". That is
 * right for a record in another organization — confirming an id exists elsewhere
 * would leak — and badly wrong for a renderer that could not start: it told a
 * person looking at their own invoice that the invoice was gone.
 *
 * The distinction matters because the two need opposite responses. A missing
 * record is final. A renderer that cannot start is a server problem the reader
 * can walk around, because the same document is available as HTML and every
 * browser can print that itself.
 */
import { NextResponse } from "next/server";
import { logger } from "@/platform/logger";

/**
 * Did this fail because the PDF could not be produced, rather than because the
 * document could not be found?
 *
 * Matched on the shapes the renderer actually throws. Deliberately narrow: an
 * unrecognised error still falls through to 404, so a genuine lookup failure is
 * never dressed up as a server problem.
 */
export function isRenderFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "PdfBusyError") return true;
  const text = `${err.name} ${err.message}`.toLowerCase();
  return [
    // The one production actually threw. @sparticuz/chromium decompresses its
    // payload out of a bin/ directory that was never traced into the function,
    // and says so in exactly these words — which the first version of this
    // matcher missed, so the honest 503 would have gone on being a 404.
    "input directory does not exist",
    "executablepath", // …or it could not work out where the binary should be
    "enoent", // …or the path it resolved is not there
    "browsertype.launch", // playwright could not start the browser
    "failed to launch",
    "target closed",
    "protocol error",
    "timeout",
    "chromium",
  ].some((needle) => text.includes(needle));
}

/**
 * The answer a reader can act on.
 *
 * 503 rather than 500: this is a capability the server is currently missing, not
 * a corrupt request. The message says the document is fine, because the first
 * thing anybody assumes when a download fails is that their data is not.
 */
export function renderUnavailable(
  err: unknown,
  printUrl: string,
  accept: string | null = null,
): NextResponse {
  logger.error(
    { err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) },
    "document PDF render failed — falling back to browser print",
  );

  /*
   * Answer in the shape the caller asked for.
   *
   * Download PDF is a plain link, deliberately — it works with middle-click,
   * with the keyboard and into a new tab, which a scripted button does not. But
   * a link NAVIGATES, so a JSON body would put a person on a page of raw JSON
   * and leave them to interpret it. A browser says what it wants in Accept, so
   * a browser gets a page and a script gets the JSON it can act on.
   */
  if (accept?.includes("text/html")) {
    return new NextResponse(pdfUnavailablePage(printUrl), {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "60",
      },
    });
  }
  return NextResponse.json(
    {
      error: "pdf_unavailable",
      message:
        "The document is fine. This server could not run the PDF renderer, " +
        "so open the document and use your browser's Print to save it as a PDF.",
      printUrl,
    },
    {
      status: 503,
      headers: { "cache-control": "no-store", "retry-after": "60" },
    },
  );
}

/**
 * The same answer, as a page, for somebody who is not signed in.
 *
 * A share recipient has no support channel and no way to tell a broken link
 * from a broken renderer, so the page says which it is and puts them back on
 * the document — where their own browser can print it.
 */
export function pdfUnavailablePage(documentUrl: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>PDF unavailable</title></head>" +
    '<body style="margin:0;display:grid;place-items:center;min-height:100vh;' +
    'font-family:system-ui,sans-serif;background:#f6f6f6;color:#1a1a1a;">' +
    '<main style="max-width:34rem;padding:2rem;text-align:center;">' +
    '<h1 style="font-size:1.25rem;margin:0 0 .75rem;">The document is fine</h1>' +
    '<p style="margin:0 0 1.5rem;line-height:1.6;color:#444;">' +
    "We could not build a PDF just now. Open the document and use your " +
    "browser&rsquo;s Print to save it as one.</p>" +
    '<a href="' +
    documentUrl +
    '" style="display:inline-block;padding:.6rem 1rem;' +
    'border:1px solid #1a1a1a;border-radius:6px;color:#1a1a1a;text-decoration:none;">' +
    "Open the document</a></main></body></html>"
  );
}
