/**
 * HTML to PDF (H22.0).
 *
 * The PDF is the SAME HTML the browser preview shows, printed by a browser.
 * There is no second template and no second layout engine, so preview, print
 * and PDF cannot disagree about what a document looks like — a class of bug
 * that is otherwise discovered by a customer holding a wrong invoice.
 *
 * Two executables, one API. On Vercel the browser binary is @sparticuz/chromium,
 * a Chromium built to run in a serverless container; locally and in CI it is the
 * Chromium the end-to-end suite already installs. Both are launched through
 * playwright-core, so the driver under test is the driver that runs and only
 * the executable path differs.
 *
 * Fonts: the document carries its own @font-face (see render.ts). Nothing here
 * depends on a font being installed in the container, which is what makes
 * Arabic render on Linux at all.
 */
import type { Browser } from "playwright-core";

export type PdfOptions = {
  /** Shown in the PDF's own metadata and used for the download filename. */
  title?: string;
  /** Print background colours and shading. Off would drop the table headers. */
  printBackground?: boolean;
  /**
   * Print "2 / 4" in the bottom margin.
   *
   * Chrome is the only thing that knows how many pages the document became, and
   * it exposes that count solely through the footer template. CSS paged-media
   * margin boxes, which would let the shell draw this itself, are not
   * implemented in Chrome.
   *
   * Digits, with no word in front of them: Chrome renders this footer in an
   * isolated document that shares none of the page's CSS, so it cannot use the
   * bundled Arabic face, and an Arabic label there would be empty boxes on a
   * container with no Arabic font. "2 / 4" needs no font that a machine might
   * be missing and reads the same in both languages.
   */
  pageNumbers?: boolean;
  /** Right-to-left document, so the footer sits on the mirrored edge. */
  rtl?: boolean;
};

/** The shape this file uses from @sparticuz/chromium, which ships no types. */
type SparticuzChromium = { args: string[]; executablePath: () => Promise<string> };

let cached: Browser | null = null;

/** True when running somewhere @sparticuz/chromium is the right binary. */
function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

async function launch(): Promise<Browser> {
  if (cached?.isConnected()) return cached;
  const { chromium } = await import("playwright-core");

  if (isServerless()) {
    // @sparticuz/chromium ships the binary and the flags a serverless container
    // needs (single-process, no /dev/shm). Playwright drives it by path; only
    // the executable differs from the local run.
    const mod = (await import("@sparticuz/chromium")) as unknown as {
      default?: SparticuzChromium;
    } & Partial<SparticuzChromium>;
    const sparticuz = (mod.default ?? mod) as SparticuzChromium;
    cached = await chromium.launch({
      executablePath: await sparticuz.executablePath(),
      args: sparticuz.args,
      headless: true,
    });
    return cached;
  }

  // Locally and in CI, Playwright's own download. An explicit override exists
  // for a machine that keeps Chrome somewhere else.
  const override = process.env.CHROME_EXECUTABLE_PATH;
  cached = await chromium.launch({
    ...(override ? { executablePath: override } : {}),
    headless: true,
  });
  return cached;
}

/**
 * Render a complete HTML document to A4 PDF bytes.
 *
 * Margins live in the document's own `@page` rule, not here: the shell owns the
 * page geometry so the browser preview and the PDF agree on it.
 *
 * The page number is the one thing the shell cannot draw. Only the browser knows
 * how many pages the content became, and Chrome exposes that count nowhere
 * except the footer template, so the footer is drawn here when the caller asks
 * for numbering. The header stays empty: the document draws its own.
 */
/**
 * Chrome's footer, rendered in its own isolated document: it inherits none of
 * the page's CSS, so every style it needs is stated inline here.
 *
 * `pageNumber` and `totalPages` are substituted by Chrome.
 */
function pageFooterTemplate(rtl: boolean): string {
  return (
    `<div style="width:100%;padding:0 12mm;font-size:9px;color:#666;` +
    `font-family:Arial,sans-serif;text-align:${rtl ? "left" : "right"};">` +
    `<span class="pageNumber"></span> / <span class="totalPages"></span>` +
    `</div>`
  );
}

/**
 * How many documents may be rendering at once in this process.
 *
 * Every render opens a page in the shared Chromium and lays out a full document;
 * the public share route can start one without a signed-in member behind it. The
 * per-IP rate limit bounds one caller, not the total, so this bounds the total.
 * Rejecting rather than queueing is deliberate: a caller waiting behind a long
 * queue would hit the route's own timeout anyway, having held a connection open
 * for the whole wait.
 */
const MAX_CONCURRENT_RENDERS = 4;
let activeRenders = 0;

export class PdfBusyError extends Error {
  constructor() {
    super("too many documents are rendering at once");
    this.name = "PdfBusyError";
  }
}

export async function renderPdf(html: string, options: PdfOptions = {}): Promise<Uint8Array> {
  if (activeRenders >= MAX_CONCURRENT_RENDERS) throw new PdfBusyError();
  activeRenders++;
  try {
    return await renderPdfInner(html, options);
  } finally {
    activeRenders--;
  }
}

/**
 * Render, and survive a browser that died while the container was asleep.
 *
 * A serverless instance is FROZEN between requests, and the Chromium it started
 * does not come back — but the handle still says `isConnected()`, so the cached
 * browser looks perfectly healthy until the first thing that touches it throws.
 *
 * The symptom in production was a Download PDF that worked, failed, then worked
 * again: the first request on an instance launched a browser and rendered, the
 * second reused the corpse and failed in under a second, and the third launched
 * a new one because by then the handle finally admitted it was gone.
 *
 * So a cached browser gets exactly one chance to prove it is alive. If it is
 * not, it is thrown away and the render is done again on a fresh one. A cold
 * launch has nothing cached, so it is never retried and a genuine rendering
 * error is not paid for twice.
 */
async function renderPdfInner(html: string, options: PdfOptions): Promise<Uint8Array> {
  const wasCached = cached !== null;
  try {
    return await renderOnce(html, options);
  } catch (err) {
    if (!wasCached) throw err;
    await closePdfBrowser();
    return await renderOnce(html, options);
  }
}

async function renderOnce(html: string, options: PdfOptions): Promise<Uint8Array> {
  const browser = await launch();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    // Fonts must be ready or the first page can print in a fallback face.
    await page.evaluate(() => (document as unknown as { fonts: FontFaceSet }).fonts.ready);
    const numbered = options.pageNumbers ?? false;
    const bytes = await page.pdf({
      format: "a4",
      printBackground: options.printBackground ?? true,
      preferCSSPageSize: true,
      displayHeaderFooter: numbered,
      ...(numbered
        ? {
            headerTemplate: "<div></div>",
            footerTemplate: pageFooterTemplate(options.rtl ?? false),
          }
        : {}),
    });
    return bytes;
  } finally {
    await page.close();
  }
}

/**
 * The bundled font files as base64, read once.
 *
 * The PDF path needs these because it loads the document through setContent(),
 * where a relative `/fonts/...` URL has no origin to resolve against. Without
 * them the renderer silently falls back to a host font, which is how Arabic
 * becomes empty boxes on a container that has none.
 */
let fontCache: Record<string, string> | null = null;

export async function embeddedDocumentFonts(): Promise<Record<string, string>> {
  if (fontCache) return fontCache;
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { DOCUMENT_FONT_FILES } = await import("./render");
  const out: Record<string, string> = {};
  for (const file of DOCUMENT_FONT_FILES) {
    try {
      const bytes = await readFile(path.join(process.cwd(), "public", "fonts", file));
      out[file] = bytes.toString("base64");
    } catch {
      // A missing face is not fatal: the document still renders, in a fallback
      // face. It IS visible, because the PDF then embeds a different font name.
    }
  }
  fontCache = out;
  return out;
}

/** Release the shared browser. Called by tests; serverless reuses it warm. */
export async function closePdfBrowser(): Promise<void> {
  if (cached) {
    await cached.close().catch(() => {});
    cached = null;
  }
}
