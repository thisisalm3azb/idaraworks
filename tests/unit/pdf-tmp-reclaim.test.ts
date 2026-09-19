/**
 * The serverless PDF browser must start on a temp directory that previous,
 * dead browsers have not filled (production 2026-09-19: "Less than 64MB of
 * free space in temporary directory for shared memory files: 2").
 */
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStaleBrowserArtefact, reclaimBrowserTemp } from "@/platform/documents/tmp-reclaim";

describe("isStaleBrowserArtefact", () => {
  it("recognises what Playwright and Chromium leave behind", () => {
    expect(isStaleBrowserArtefact("playwright_chromiumdev_profile-AbC123")).toBe(true);
    expect(isStaleBrowserArtefact(".org.chromium.Chromium.x9Yz")).toBe(true);
    expect(isStaleBrowserArtefact(".com.google.Chrome.q1W2")).toBe(true);
  });

  it("leaves everything else alone — including the unpacked browser itself", () => {
    for (const name of [
      "chromium",
      "al2023",
      "fonts",
      "swiftshader",
      "chromium-pack.tar",
      "playwright-core",
      "profile",
      "org.chromium.Chromium.x",
      "playwright_chromiumdev_profile",
    ])
      expect(isStaleBrowserArtefact(name), name).toBe(false);
  });
});

describe("reclaimBrowserTemp", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "reclaim-test-"));
    await mkdir(path.join(dir, "playwright_chromiumdev_profile-dead1", "Default"), {
      recursive: true,
    });
    await writeFile(
      path.join(dir, "playwright_chromiumdev_profile-dead1", "Default", "Cache"),
      "x".repeat(1024),
    );
    await writeFile(path.join(dir, ".org.chromium.Chromium.shm1"), "y".repeat(512));
    await mkdir(path.join(dir, "chromium"), { recursive: true }); // the unpacked browser
    await writeFile(path.join(dir, "chromium", "chrome"), "binary");
    await writeFile(path.join(dir, "unrelated.txt"), "keep");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("removes only the stale browser artefacts and reports free space", async () => {
    const r = await reclaimBrowserTemp(dir);
    expect(r.removed).toBe(2);
    expect(r.failed).toBe(0);
    const left = (await readdir(dir)).sort();
    expect(left).toEqual(["chromium", "unrelated.txt"]);
    // statfs is available on Linux, macOS and Windows in Node 18.15+.
    expect(r.freeBytes === null || r.freeBytes > 0).toBe(true);
  });

  it("is idempotent and tolerates a directory that does not exist", async () => {
    await reclaimBrowserTemp(dir);
    const again = await reclaimBrowserTemp(dir);
    expect(again.removed).toBe(0);
    const missing = await reclaimBrowserTemp(path.join(dir, "nope"));
    expect(missing).toEqual({ removed: 0, failed: 0, freeBytes: null });
  });
});

describe("pdf.ts wiring", () => {
  it("reclaims the temp directory before every serverless launch, and only there", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../src/platform/documents/pdf.ts"),
      "utf8",
    );
    const serverless = src.slice(
      src.indexOf("if (isServerless())"),
      src.indexOf("// Locally and in CI"),
    );
    expect(serverless).toContain("reclaimBrowserTemp(");
    expect(serverless.indexOf("reclaimBrowserTemp(")).toBeLessThan(
      serverless.indexOf("chromium.launch("),
    );
    const local = src.slice(src.indexOf("// Locally and in CI"));
    expect(local).not.toContain("reclaimBrowserTemp(");
  });
});
