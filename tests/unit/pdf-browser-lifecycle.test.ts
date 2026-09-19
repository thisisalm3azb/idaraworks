/**
 * The PDF renderer's browser lifecycle, with the browser and the serverless
 * bits replaced by fakes so every branch is exercised deterministically:
 *
 *   - concurrent renders on an instance with no browser share ONE launch
 *   - a cached browser that has died gets exactly one relaunch
 *   - on a serverless instance the temp directory is reclaimed before every
 *     launch and never while a browser is live
 *   - a healthy browser is retired after a bounded number of renders, or as
 *     soon as the temp disk is low, and only when no other render is in flight
 *
 * Production 2026-09-19: sustained PDF downloads started answering 503 once the
 * instance's /tmp filled with what dead browsers left behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakePage = {
  setContent: () => Promise<void>;
  evaluate: () => Promise<void>;
  pdf: () => Promise<Uint8Array>;
  close: () => Promise<void>;
};
type FakeBrowser = {
  connected: boolean;
  pages: number;
  closed: number;
  isConnected: () => boolean;
  newPage: () => Promise<FakePage>;
  close: () => Promise<void>;
};

const state = vi.hoisted(() => ({
  launches: 0,
  browsers: [] as FakeBrowser[],
  failNextPage: 0,
  reclaims: 0,
  freeBytes: (500 * 1024 * 1024) as number | null,
  liveAtReclaim: [] as boolean[],
  freeGate: null as Promise<void> | null,
  pdfGate: null as Promise<void> | null,
}));

vi.mock("playwright-core", () => ({
  chromium: {
    launch: async () => {
      // A launch takes time: that is what makes two concurrent callers race.
      await new Promise((r) => setTimeout(r, 20));
      state.launches++;
      const browser: FakeBrowser = {
        connected: true,
        pages: 0,
        closed: 0,
        isConnected: () => browser.connected,
        newPage: async () => {
          if (state.failNextPage > 0) {
            state.failNextPage--;
            browser.connected = false;
            throw new Error("Target page, context or browser has been closed");
          }
          browser.pages++;
          return {
            setContent: async () => {},
            evaluate: async () => {},
            pdf: async () => {
              if (state.pdfGate) await state.pdfGate;
              if (!browser.connected)
                throw new Error("Target page, context or browser has been closed");
              return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
            },
            close: async () => {},
          };
        },
        close: async () => {
          browser.closed++;
          browser.connected = false;
        },
      };
      state.browsers.push(browser);
      return browser;
    },
  },
}));

vi.mock("@sparticuz/chromium", () => ({
  default: { args: ["--fake"], executablePath: async () => "/tmp/fake-chromium" },
}));

vi.mock("@/platform/documents/tmp-reclaim", () => ({
  reclaimBrowserTemp: async () => {
    state.reclaims++;
    state.liveAtReclaim.push(state.browsers.some((b) => b.connected));
    return { removed: 0, failed: 0, freeBytes: state.freeBytes };
  },
  tempFreeBytes: async () => {
    if (state.freeGate) await state.freeGate;
    return state.freeBytes;
  },
  describeTemp: async () => [],
}));

vi.mock("@/platform/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

async function fresh() {
  vi.resetModules();
  state.launches = 0;
  state.browsers = [];
  state.failNextPage = 0;
  state.reclaims = 0;
  state.freeBytes = 500 * 1024 * 1024;
  state.liveAtReclaim = [];
  state.freeGate = null;
  state.pdfGate = null;
  return await import("@/platform/documents/pdf");
}

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

const html = "<!doctype html><html><body>x</body></html>";

describe("PDF browser lifecycle", () => {
  const env = { ...process.env };
  beforeEach(() => {
    delete process.env.VERCEL;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  });
  afterEach(() => {
    process.env = { ...env };
    delete process.env.PDF_QUEUE_WAIT_MS;
    delete process.env.PDF_RENDER_SLOTS;
  });

  it("four concurrent renders share one launch and one browser", async () => {
    const pdf = await fresh();
    const out = await Promise.all([1, 2, 3, 4].map(() => pdf.renderPdf(html)));
    expect(out.every((b) => b.length === 4)).toBe(true);
    expect(state.launches).toBe(1);
    expect(state.browsers[0]!.pages).toBe(4);
    await pdf.closePdfBrowser();
  });

  it("renders beyond the slots wait for a slot; beyond the queue bound they are refused", async () => {
    const pdf = await fresh();
    const hold = gate();
    state.pdfGate = hold.p;
    const inFlight = [1, 2, 3, 4].map(() => pdf.renderPdf(html));
    await tick(50);
    expect(pdf.pdfBrowserStateForTests().activeRenders).toBe(4);
    const queued = [1, 2, 3, 4, 5, 6, 7, 8].map(() => pdf.renderPdf(html));
    await tick(10);
    expect(pdf.pdfBrowserStateForTests().queued).toBe(8);
    await expect(pdf.renderPdf(html)).rejects.toBeInstanceOf(pdf.PdfBusyError); // 13th: queue full
    state.pdfGate = null;
    hold.open();
    const out = await Promise.all([...inFlight, ...queued]);
    expect(out.every((b) => b.length === 4)).toBe(true);
    expect(state.launches).toBe(1);
    expect(pdf.pdfBrowserStateForTests().activeRenders).toBe(0);
    await pdf.closePdfBrowser();
  });

  it("serverless: renders run one at a time and the rest wait their turn", async () => {
    process.env.VERCEL = "1";
    const pdf = await fresh();
    expect(pdf.renderSlots()).toBe(1);
    const hold = gate();
    state.pdfGate = hold.p;
    const all = [1, 2, 3].map(() => pdf.renderPdf(html));
    await tick(80);
    expect(state.browsers[0]!.pages).toBe(1); // only one page open at a time
    expect(pdf.pdfBrowserStateForTests().queued).toBe(2);
    state.pdfGate = null;
    hold.open();
    const out = await Promise.all(all);
    expect(out.every((b) => b.length === 4)).toBe(true);
    expect(state.browsers[0]!.pages).toBe(3);
    expect(state.launches).toBe(1);
    await pdf.closePdfBrowser();
  });

  it("a render that waits longer than the bound is refused, and the slot is not lost", async () => {
    process.env.VERCEL = "1";
    process.env.PDF_QUEUE_WAIT_MS = "60";
    const pdf = await fresh();
    const hold = gate();
    state.pdfGate = hold.p;
    const first = pdf.renderPdf(html);
    await tick(20);
    await expect(pdf.renderPdf(html)).rejects.toBeInstanceOf(pdf.PdfBusyError);
    state.pdfGate = null;
    hold.open();
    expect((await first).length).toBe(4);
    expect(pdf.pdfBrowserStateForTests().activeRenders).toBe(0);
    expect(pdf.pdfBrowserStateForTests().queued).toBe(0);
    await pdf.closePdfBrowser();
  });

  it("PDF_RENDER_SLOTS raises the serverless bound without a code change", async () => {
    process.env.VERCEL = "1";
    process.env.PDF_RENDER_SLOTS = "3";
    const pdf = await fresh();
    expect(pdf.renderSlots()).toBe(3);
  });

  it("a cached browser that died gets exactly one relaunch, and the render succeeds", async () => {
    const pdf = await fresh();
    await pdf.renderPdf(html); // launches #1
    state.failNextPage = 1; // #1 is a corpse on the next touch
    const bytes = await pdf.renderPdf(html);
    expect(bytes.length).toBe(4);
    expect(state.launches).toBe(2);
    expect(state.browsers[0]!.closed).toBe(1); // the corpse was closed, not abandoned
    await pdf.closePdfBrowser();
  });

  it("a cold launch that fails is not retried", async () => {
    const pdf = await fresh();
    state.failNextPage = 1;
    await expect(pdf.renderPdf(html)).rejects.toThrow(/closed/);
    expect(state.launches).toBe(1);
    await pdf.closePdfBrowser();
  });

  it("serverless: reclaims temp before every launch, never with a live browser, and not locally", async () => {
    const local = await fresh();
    await local.renderPdf(html);
    expect(state.reclaims).toBe(0);
    await local.closePdfBrowser();

    process.env.VERCEL = "1";
    const pdf = await fresh();
    await pdf.renderPdf(html);
    await pdf.renderPdf(html);
    expect(state.launches).toBe(1);
    expect(state.reclaims).toBe(1);
    state.failNextPage = 1;
    await pdf.renderPdf(html);
    expect(state.launches).toBe(2);
    expect(state.reclaims).toBe(2);
    expect(state.liveAtReclaim).toEqual([false, false]);
    await pdf.closePdfBrowser();
  });

  it("serverless: retires a healthy browser after the bounded number of renders", async () => {
    process.env.VERCEL = "1";
    const pdf = await fresh();
    for (let i = 0; i < pdf.RECYCLE_AFTER_RENDERS; i++) await pdf.renderPdf(html);
    expect(state.launches).toBe(1);
    expect(state.browsers[0]!.closed).toBe(1); // retired after the 25th render
    expect(pdf.pdfBrowserStateForTests().cached).toBe(false);
    await pdf.renderPdf(html);
    expect(state.launches).toBe(2);
    expect(state.reclaims).toBe(2);
    await pdf.closePdfBrowser();
  });

  it("serverless: retires the browser as soon as the temp disk is low, but not under a concurrent render", async () => {
    process.env.VERCEL = "1";
    process.env.PDF_RENDER_SLOTS = "2"; // two slots: the only way two renders share a browser on serverless
    const pdf = await fresh();
    await pdf.renderPdf(html);
    state.freeBytes = 10 * 1024 * 1024;
    // Two renders in flight together: neither may retire the browser under the other.
    await Promise.all([pdf.renderPdf(html), pdf.renderPdf(html)]);
    expect(state.browsers[0]!.pages).toBe(3);
    // The next lone render sees the low disk and retires the browser after itself.
    await pdf.renderPdf(html);
    expect(state.browsers[0]!.pages).toBe(4);
    expect(state.browsers[0]!.closed).toBe(1);
    expect(pdf.pdfBrowserStateForTests().cached).toBe(false);
    await pdf.renderPdf(html);
    expect(state.launches).toBe(2);
    await pdf.closePdfBrowser();
  });

  it("serverless: a render that attaches while another is deciding to retire keeps its browser", async () => {
    // Production 2026-09-19: with the floor above the instance's steady free
    // space, every render retired the browser, and a concurrent render that had
    // just attached died with "browser has been closed".
    process.env.VERCEL = "1";
    process.env.PDF_RENDER_SLOTS = "2"; // two slots: the only way two renders share a browser on serverless
    const pdf = await fresh();
    await pdf.renderPdf(html);
    state.freeBytes = 10 * 1024 * 1024;
    const probe = gate();
    state.freeGate = probe.p;
    const a = pdf.renderPdf(html); // renders, then blocks in its free-space probe
    await tick(50);
    const pending = gate();
    state.pdfGate = pending.p;
    const b = pdf.renderPdf(html); // attaches to the same browser, blocks in page.pdf
    await tick(50);
    expect(state.browsers[0]!.pages).toBe(3);
    state.freeGate = null;
    probe.open(); // A decides: B is in flight, so no retirement
    await a;
    expect(state.browsers[0]!.closed).toBe(0);
    state.pdfGate = null;
    pending.open();
    await b; // B finishes alone and retires the browser after itself
    expect(state.launches).toBe(1);
    expect(state.browsers[0]!.closed).toBe(1);
    expect(pdf.pdfBrowserStateForTests().cached).toBe(false);
    await pdf.closePdfBrowser();
  });

  it("shouldRecycle: bounded renders or low space", async () => {
    const pdf = await fresh();
    // The floor is Chromium's own launch minimum; an instance's steady ~90 MB must not trip it.
    expect(pdf.RECYCLE_BELOW_FREE_BYTES).toBe(64 * 1024 * 1024);
    expect(pdf.shouldRecycle(90 * 1024 * 1024, 1)).toBe(false);
    expect(pdf.shouldRecycle(null, 0)).toBe(false);
    expect(pdf.shouldRecycle(null, pdf.RECYCLE_AFTER_RENDERS)).toBe(true);
    expect(pdf.shouldRecycle(pdf.RECYCLE_BELOW_FREE_BYTES - 1, 1)).toBe(true);
    expect(pdf.shouldRecycle(pdf.RECYCLE_BELOW_FREE_BYTES, 1)).toBe(false);
  });
});
