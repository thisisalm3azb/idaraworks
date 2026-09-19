/**
 * Reclaim the temporary directory before launching the serverless PDF browser.
 *
 * WHY. A Vercel function has one small `/tmp` (512 MB) that lives as long as
 * the instance, and with Fluid compute an instance lives a long time and
 * serves every tenant. @sparticuz/chromium unpacks the browser into it once
 * (~300 MB). Every Chromium launch then creates a profile directory there
 * (`playwright_chromiumdev_profile-*`), and every render writes shared-memory
 * files there (`.org.chromium.Chromium.*`), because a container has no usable
 * `/dev/shm`. A browser that exits cleanly removes its own; a browser that
 * dies — and the H22F note in pdf.ts explains why they do — leaves them.
 *
 * Production, 2026-09-19: a finance user's fourth PDF in a row failed with 503
 * and every later one on that instance failed too. Chromium's own log said
 * why: "Less than 64MB of free space in temporary directory for shared memory
 * files: 2" — two megabytes left. Each retry launched another browser into a
 * full disk, which died at `page.pdf`, and the instance stayed unusable for
 * PDFs until Vercel recycled it.
 *
 * WHAT. Before a fresh launch (there is no live browser at that point, so
 * nothing here is in use), remove the leftovers of previous browsers from the
 * temp directory. Only names Chromium and Playwright are known to create are
 * touched; nothing else in `/tmp` — not the unpacked browser, not the fonts —
 * is looked at. Failure to remove something is logged, never thrown: a full
 * disk must not become a launch that never happens.
 *
 * Pure enough to test: the directory is a parameter, and the recogniser is a
 * function of the name alone.
 */
import { readdir, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Artefacts a Chromium launch leaves behind when it does not exit cleanly. */
const STALE_BROWSER_ARTEFACT =
  /^(playwright_chromiumdev_profile-|\.org\.chromium\.Chromium\.|\.com\.google\.Chrome\.)/;

export function isStaleBrowserArtefact(name: string): boolean {
  return STALE_BROWSER_ARTEFACT.test(name);
}

export type ReclaimResult = {
  /** Entries removed. */
  removed: number;
  /** Entries that matched but could not be removed. */
  failed: number;
  /** Free bytes in the directory afterwards, when the platform can say. */
  freeBytes: number | null;
};

export async function reclaimBrowserTemp(dir: string = tmpdir()): Promise<ReclaimResult> {
  const out: ReclaimResult = { removed: 0, failed: 0, freeBytes: null };
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return out; // no directory, nothing to reclaim
  }
  for (const name of names) {
    if (!isStaleBrowserArtefact(name)) continue;
    try {
      await rm(path.join(dir, name), { recursive: true, force: true });
      out.removed++;
    } catch {
      out.failed++;
    }
  }
  try {
    const s = await statfs(dir);
    out.freeBytes = Number(s.bavail) * Number(s.bsize);
  } catch {
    // statfs is unavailable on some platforms; the count above still stands.
  }
  return out;
}
