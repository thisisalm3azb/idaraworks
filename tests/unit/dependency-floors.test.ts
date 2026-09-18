/**
 * Dependency security floors (2026-09-19).
 *
 * `tooling/scripts/audit-bulk.mjs` is the live gate: it asks the registry which
 * advisories apply to the exact installed prod tree. This test is the
 * complementary, offline one: it pins the lockfile — the thing `pnpm install
 * --frozen-lockfile` actually installs — above the first patched version of
 * each advisory resolved on that date, so a lockfile revert, a stray
 * resolution or an override that quietly re-introduces a vulnerable copy fails
 * here with the advisory named, whether or not the registry is reachable.
 *
 * It also reads the libheif version out of the sharp binary that is actually
 * loaded, because the AVIF advisories are in libheif, not in sharp's own code:
 * a lockfile at 0.35.4 with a stale prebuilt binary would pass a version check
 * and still be vulnerable.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

type Floor = { major: number; min: string; advisory: string };

/** First patched version per major line. A major above every listed line is
 * a newer, unaffected release and passes; a major below the lowest is a line
 * the advisory did not patch and fails. */
const FLOORS: Record<string, Floor[]> = {
  next: [
    { major: 15, min: "15.5.24", advisory: "GHSA-p293-qw3h-jr36 + GHSA-2xp9-vwfh-vxw4 (critical)" },
    { major: 16, min: "16.3.3", advisory: "GHSA-p293-qw3h-jr36 + GHSA-2xp9-vwfh-vxw4 (critical)" },
  ],
  sharp: [{ major: 0, min: "0.35.4", advisory: "GHSA-rgj7-g3m4-5g8c (high, libheif)" }],
  "js-yaml": [
    { major: 3, min: "3.15.2", advisory: "GHSA-2883-xcg3-v3hh + GHSA-5p4m-2wfm-xmqj (high)" },
    { major: 4, min: "4.3.2", advisory: "GHSA-2883-xcg3-v3hh + GHSA-5p4m-2wfm-xmqj (high)" },
  ],
  vitest: [{ major: 4, min: "4.1.11", advisory: "GHSA-82fw-gwwq-j7x9 (moderate)" }],
  "@vitest/mocker": [{ major: 4, min: "4.1.11", advisory: "GHSA-82fw-gwwq-j7x9 (moderate)" }],
  "baseline-browser-mapping": [
    { major: 2, min: "2.11.0", advisory: "GHSA-w5vr-8v7q-w6rv (moderate)" },
  ],
};

/** The libheif the sharp binary was built against; GHSA-rgj7-g3m4-5g8c's fix. */
const LIBHEIF_MIN = "1.23.2";

function parse(v: string): number[] {
  return v
    .split("-")[0]!
    .split(".")
    .map((n) => Number.parseInt(n, 10));
}

function atLeast(v: string, min: string): boolean {
  const a = parse(v);
  const b = parse(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Every resolved version of a package in the lockfile (`packages:` and
 * `snapshots:` both key on `name@version`). Written without escape
 * sequences on purpose: a package name is letters, digits, "@", "/", "-" and
 * ".", so only "." needs neutralising. */
function lockedVersions(lock: string, name: string): string[] {
  const literal = name.split(".").join("[.]");
  // Scoped names are quoted in the lockfile: `  '@vitest/mocker@4.1.11':`.
  const re = new RegExp("^  '?" + literal + "@([0-9]+[.][0-9]+[.][0-9]+[^:(' ]*)[:(']", "gm");
  const out = new Set<string>();
  for (const m of lock.matchAll(re)) out.add(m[1]!);
  return [...out];
}

const lock = readFileSync(path.resolve(__dirname, "../../pnpm-lock.yaml"), "utf8");

describe("dependency security floors (pnpm-lock.yaml)", () => {
  for (const [name, floors] of Object.entries(FLOORS)) {
    it(`${name} is at or above its patched floor`, () => {
      const versions = lockedVersions(lock, name);
      expect(versions, `${name} is not in the lockfile at all`).not.toHaveLength(0);
      const highest = Math.max(...floors.map((f) => f.major));
      for (const v of versions) {
        const major = parse(v)[0]!;
        if (major > highest) continue; // a newer, unaffected line
        const floor = floors.find((f) => f.major === major);
        expect(floor, `${name}@${v}: the ${major}.x line has no patched release`).toBeDefined();
        expect(
          atLeast(v, floor!.min),
          `${name}@${v} is below ${floor!.min} — ${floor!.advisory}`,
        ).toBe(true);
      }
    });
  }
});

describe("sharp native binary", () => {
  it("loads a libheif at or above the patched version", () => {
    expect(sharp.versions.heif, "sharp.versions.heif").toBeDefined();
    expect(
      atLeast(sharp.versions.heif!, LIBHEIF_MIN),
      `libheif ${sharp.versions.heif} is below ${LIBHEIF_MIN} — GHSA-rgj7-g3m4-5g8c`,
    ).toBe(true);
  });

  it("is the same sharp the lockfile pins", () => {
    const locked = lockedVersions(lock, "sharp");
    expect(locked).toContain(sharp.versions.sharp);
  });
});

describe("version comparison helper", () => {
  it("orders numerically, not lexically", () => {
    expect(atLeast("16.3.5", "16.3.3")).toBe(true);
    expect(atLeast("16.10.0", "16.3.3")).toBe(true);
    expect(atLeast("16.2.12", "16.3.3")).toBe(false);
    expect(atLeast("0.35.4", "0.35.4")).toBe(true);
    expect(atLeast("1.23.2", "1.23.2")).toBe(true);
    expect(atLeast("1.9.0", "1.23.2")).toBe(false);
    expect(atLeast("4.3.2-rc.1", "4.3.2")).toBe(true); // prerelease suffix is ignored
  });
});
