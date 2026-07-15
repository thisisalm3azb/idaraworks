/**
 * U5 dashboard chart geometry + KPI formatting — pure math, no DOM.
 */
import { describe, expect, it } from "vitest";
import {
  areaPath,
  arcPath,
  clamp01,
  computeDelta,
  donutSegments,
  formatCompact,
  linePath,
  niceMax,
  scaleSeries,
  stackSegments,
  ticks,
} from "@/platform/ui/dashboard/geometry";

describe("niceMax / ticks", () => {
  it("rounds up to 1/2/5×10^n", () => {
    expect(niceMax(3)).toBe(5);
    expect(niceMax(5)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(11)).toBe(20);
    expect(niceMax(430)).toBe(500);
    expect(niceMax(60_000)).toBe(100_000);
  });

  it("degenerates safely (zero/negative/NaN → 1)", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-4)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
  });

  it("ticks are evenly spaced from 0 to the nice max", () => {
    expect(ticks(7, 4)).toEqual([0, 2.5, 5, 7.5, 10]);
  });
});

describe("scaleSeries / linePath / areaPath", () => {
  it("maps values into the box with 0 at the bottom edge", () => {
    const pts = scaleSeries([0, 10], 100, 50, 0);
    expect(pts[0]).toEqual({ x: 0, y: 50 });
    expect(pts[1]).toEqual({ x: 100, y: 0 });
  });

  it("keeps every point inside width×height", () => {
    const pts = scaleSeries([3, 9, 1, 14, 0], 320, 140, 8);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(8);
      expect(p.x).toBeLessThanOrEqual(312);
      expect(p.y).toBeGreaterThanOrEqual(8);
      expect(p.y).toBeLessThanOrEqual(132);
    }
  });

  it("a single point centres horizontally", () => {
    expect(scaleSeries([5], 100, 50, 0)[0]!.x).toBe(50);
  });

  it("paths render M/L sequences and close the area to the baseline", () => {
    const pts = scaleSeries([1, 2], 100, 50, 0);
    expect(linePath(pts)).toMatch(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
    expect(areaPath(pts, 50)).toMatch(/Z$/);
    expect(linePath([])).toBe("");
    expect(areaPath([], 50)).toBe("");
  });

  it("clamp01 guards NaN and out-of-range ratios", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe("donutSegments / arcPath", () => {
  it("segments cover the circle in order and skip zero values", () => {
    const segs = donutSegments([2, 0, 6], 60, 46);
    expect(segs.map((s) => s.index)).toEqual([0, 2]);
    expect(segs[0]!.start).toBe(0);
    expect(segs[0]!.end).toBeCloseTo(0.25);
    expect(segs[1]!.start).toBeCloseTo(0.25);
    expect(segs[1]!.end).toBeCloseTo(1);
  });

  it("an all-zero input yields no segments", () => {
    expect(donutSegments([0, 0], 60, 46)).toEqual([]);
  });

  it("arcs over half the circle set the large-arc flag; a full circle never degenerates", () => {
    expect(arcPath(60, 46, 0, 0.75)).toContain(" 1 1 ");
    expect(arcPath(60, 46, 0, 0.25)).toContain(" 0 1 ");
    const full = arcPath(60, 46, 0, 1);
    const [, x1, y1, , , , , x2, y2] = full.replace(/[MA]/g, "").trim().split(/[ ,]+/);
    // Start and end must not coincide (a degenerate arc renders nothing).
    expect(Math.abs(Number(x1) - Number(x2)) + Math.abs(Number(y1) - Number(y2))).toBeGreaterThan(
      0.01,
    );
  });
});

describe("stackSegments", () => {
  it("widths sum to 100% and offsets accumulate", () => {
    const segs = stackSegments([1, 3, 0, 4]);
    expect(segs.map((s) => s.index)).toEqual([0, 1, 3]);
    expect(segs.reduce((sum, s) => sum + s.widthPct, 0)).toBeCloseTo(100);
    expect(segs[1]!.startPct).toBeCloseTo(12.5);
    expect(segs[2]!.startPct).toBeCloseTo(50);
  });

  it("all-zero input yields no segments", () => {
    expect(stackSegments([0, 0, 0])).toEqual([]);
  });
});

describe("formatCompact (KPI values, Latin digits always)", () => {
  it("keeps small numbers grouped and whole", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(950)).toBe("950");
    expect(formatCompact(9_999)).toBe("9,999");
  });

  it("compacts thousands/millions/billions", () => {
    expect(formatCompact(12_340)).toBe("12.3K");
    expect(formatCompact(100_000)).toBe("100K");
    expect(formatCompact(4_500_000)).toBe("4.5M");
    expect(formatCompact(2_000_000_000)).toBe("2B");
  });

  it("handles negatives and non-finite input", () => {
    expect(formatCompact(-12_340)).toBe("-12.3K");
    expect(formatCompact(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("computeDelta", () => {
  it("signs the difference and compacts it", () => {
    expect(computeDelta(12, 7)).toEqual({ direction: "up", label: "+5" });
    expect(computeDelta(7, 12)).toEqual({ direction: "down", label: "-5" });
    expect(computeDelta(5, 5)).toEqual({ direction: "flat", label: "±0" });
  });

  it("previous zero still reports the rise", () => {
    expect(computeDelta(4, 0)).toEqual({ direction: "up", label: "+4" });
  });
});
