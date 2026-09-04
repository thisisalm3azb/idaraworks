/**
 * Assert the build actually carried the runtime payloads it was told to.
 *
 * `outputFileTracingIncludes` fails SILENTLY. A key that matches no route, a
 * glob the tracer will not expand, a payload the package renamed — every one of
 * those produces a successful build, a successful deploy, and a function missing
 * the files it needs. Nothing warns. The only place the truth is written down is
 * the build's own `.nft.json`, so this reads it.
 *
 * That is not hypothetical. Download PDF was broken in production for the whole
 * of H22, through a slice that set out to fix it: the include was added, the
 * comment explained it, and the tracer never applied it because the key was
 * wrong. Both the earlier `sharp` includes had exactly the same defect and had
 * been inert since the day they were written.
 *
 * Reads only. Run after `next build`.
 *
 *   npx tsx tooling/scripts/check-traced-payloads.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const APP = ".next/server/app";

/** What each function must be carrying, and why it is unusable without it. */
const REQUIRED: Array<{ route: string; needs: RegExp; label: string; why: string }> = [
  {
    route: "d/[token]/route.js",
    needs: /@sparticuz\/chromium\/bin\/chromium\.br$/,
    label: "browser binary",
    why: "the public share link renders a PDF",
  },
  {
    route: "api/o/[orgId]/documents/[kind]/[id]/route.js",
    needs: /@sparticuz\/chromium\/bin\/chromium\.br$/,
    label: "browser binary",
    why: "the signed-in Download PDF renders a PDF",
  },
  /*
   * The one production actually died on, twice over. playwright-core reads
   * browsers.json at REQUIRE time by path; nothing imports it, so the tracer
   * never saw it, and the driver failed before it ever looked for the browser
   * binary. Which is why fixing the binary alone changed nothing.
   */
  {
    route: "d/[token]/route.js",
    needs: /playwright-core\/browsers\.json$/,
    label: "playwright browsers.json",
    why: "playwright-core refuses to load without it, before any browser is sought",
  },
  {
    route: "api/o/[orgId]/documents/[kind]/[id]/route.js",
    needs: /playwright-core\/browsers\.json$/,
    label: "playwright browsers.json",
    why: "playwright-core refuses to load without it, before any browser is sought",
  },
  {
    route: "d/[token]/route.js",
    needs: /public\/fonts\/NotoNaskhArabic-Regular\.ttf$/,
    label: "Arabic font",
    why: "an Arabic PDF falls back to nothing on a Linux container",
  },
  /*
   * H31, found in production on the day it shipped: the manifest returned 200
   * and the icon returned 500, because this route rasterises through sharp and
   * the native libraries were never traced into its function. The same defect
   * shape as every entry above — a config key that looked right and matched
   * nothing — and the same reason this file reads the built trace rather than
   * next.config.ts.
   */
  {
    route: "api/o/[orgId]/icon/[spec]/route.js",
    needs: /@img\/sharp-linux-x64\//,
    label: "sharp native binding",
    why: "the per-tenant app icon is rasterised by sharp",
  },
  {
    route: "api/o/[orgId]/icon/[spec]/route.js",
    needs: /@img\/sharp-libvips-linux-x64\//,
    label: "sharp libvips",
    why: "sharp's binding is useless without libvips beside it",
  },
];

/** Everything @sparticuz decompresses at runtime; a rename must fail the build. */
const CHROMIUM_PAYLOADS = ["chromium.br", "al2023.tar.br", "fonts.tar.br", "swiftshader.tar.br"];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (entry.name.endsWith(".nft.json")) acc.push(p);
  }
  return acc;
}

function filesFor(route: string): string[] {
  return (JSON.parse(readFileSync(join(APP, `${route}.nft.json`), "utf8")) as { files: string[] })
    .files;
}

let failures = 0;
function check(ok: boolean, line: string): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${line}`);
}

console.log("TRACED PAYLOADS\n");

for (const { route, needs, label, why } of REQUIRED) {
  let files: string[] = [];
  try {
    files = filesFor(route);
  } catch {
    check(false, `${route} — no trace file; did the build run?`);
    continue;
  }
  const hit = files.some((f) => needs.test(f));
  check(hit, `${route.padEnd(46)} ${label}${hit ? "" : ` MISSING — ${why}`}`);
}

// Every payload, by name, so a package rename is caught rather than assumed.
const share = filesFor("d/[token]/route.js");
for (const payload of CHROMIUM_PAYLOADS) {
  const hit = share.some((f) => f.endsWith(`/bin/${payload}`));
  check(hit, `share route carries bin/${payload}`);
}

/*
 * And the blast radius. The payload is ~70 MB, so an over-broad route key is not
 * a harmless mistake — it is added to every function the key matches, and Vercel
 * refuses a function over its size limit. Reported rather than asserted: the
 * right number is whatever the config intends, and seeing it is the point.
 */
const carrying = walk(APP).filter((f) =>
  (JSON.parse(readFileSync(f, "utf8")) as { files: string[] }).files.some((x) =>
    /chromium\/bin\//.test(x),
  ),
);
console.log(`\n  ${carrying.length} function(s) carry the browser payload:`);
for (const f of carrying) {
  console.log(`    ${f.split(/[\\/]/).slice(3).join("/").replace(".nft.json", "")}`);
}

console.log(
  failures === 0
    ? "\nCARRIED — every function has the files it needs at runtime."
    : `\nMISSING — ${failures} payload(s) absent. The deploy would succeed and the feature would not.`,
);
if (failures > 0) process.exit(1);
