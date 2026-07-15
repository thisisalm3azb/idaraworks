/**
 * Pure chart geometry + number presentation for the U5 dashboard components.
 * Hand-rolled SVG math (NO chart dependency — U5 hard rule), kept free of DOM
 * and locale so every function is unit-testable (tests/unit/dashboard-geometry).
 */

export type Point = { x: number; y: number };

/** Clamp a ratio into [0,1] (guards divide-by-zero fallout downstream). */
export function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * A "nice" axis maximum ≥ the data max: 1/2/5 × 10^n steps, so gridlines land
 * on human numbers. max ≤ 0 → 1 (an all-zero series still renders a frame).
 */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = Math.pow(10, exp);
  for (const m of [1, 2, 5, 10]) {
    if (max <= m * base) return m * base;
  }
  return 10 * base;
}

/** Evenly spaced tick values from 0 to niceMax(max), inclusive. */
export function ticks(max: number, count = 4): number[] {
  const top = niceMax(max);
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push((top / count) * i);
  return out;
}

/**
 * Map a series to SVG coordinates inside width×height with the given padding.
 * y grows DOWN in SVG, so value 0 sits at the bottom edge. A single point
 * centres horizontally.
 */
export function scaleSeries(values: number[], width: number, height: number, pad = 0): Point[] {
  const top = niceMax(Math.max(0, ...values));
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const n = values.length;
  return values.map((v, i) => ({
    x: pad + (n <= 1 ? innerW / 2 : (innerW * i) / (n - 1)),
    y: pad + innerH - innerH * clamp01(v / top),
  }));
}

/** SVG path for a polyline through the points ("" when empty). */
export function linePath(points: Point[]): string {
  if (points.length === 0) return "";
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${round2(p.x)} ${round2(p.y)}`).join(" ");
}

/** Closed area path under the line (for the soft fill), "" when empty. */
export function areaPath(points: Point[], baselineY: number): string {
  if (points.length === 0) return "";
  const line = linePath(points);
  const last = points[points.length - 1]!;
  const first = points[0]!;
  return `${line} L${round2(last.x)} ${round2(baselineY)} L${round2(first.x)} ${round2(baselineY)} Z`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ── Donut ─────────────────────────────────────────────────────────────────────
export type DonutSegment = {
  /** Original index into the input array (zero-count entries are dropped). */
  index: number;
  value: number;
  /** Start/end fractions of the full circle in [0,1]. */
  start: number;
  end: number;
  /** SVG arc path for a ring segment centred at (c,c). */
  path: string;
};

/**
 * Ring segments for a donut of outer radius r and stroke width w, centred at
 * (c,c). Zero/negative values are skipped; an all-zero input yields [].
 */
export function donutSegments(values: number[], c: number, r: number): DonutSegment[] {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  if (total <= 0) return [];
  const segments: DonutSegment[] = [];
  let acc = 0;
  values.forEach((raw, index) => {
    const value = Math.max(0, raw);
    if (value === 0) return;
    const start = acc / total;
    acc += value;
    const end = acc / total;
    segments.push({ index, value, start, end, path: arcPath(c, r, start, end) });
  });
  return segments;
}

/** Arc from fraction a to fraction b of a circle (12 o'clock start, clockwise). */
export function arcPath(c: number, r: number, a: number, b: number): string {
  // A full single-segment circle must not degenerate (arc with same start/end).
  const gap = b - a >= 1 ? 0.9999 : b - a;
  const [x1, y1] = pointOnCircle(c, r, a);
  const [x2, y2] = pointOnCircle(c, r, a + gap);
  const largeArc = gap > 0.5 ? 1 : 0;
  return `M${round2(x1)} ${round2(y1)} A${r} ${r} 0 ${largeArc} 1 ${round2(x2)} ${round2(y2)}`;
}

function pointOnCircle(c: number, r: number, fraction: number): [number, number] {
  const angle = 2 * Math.PI * fraction - Math.PI / 2; // start at 12 o'clock
  return [c + r * Math.cos(angle), c + r * Math.sin(angle)];
}

// ── Stacked / distribution bar ────────────────────────────────────────────────
export type StackSegment = { index: number; value: number; startPct: number; widthPct: number };

/** Percentage layout for a one-row stacked bar; zero values are skipped. */
export function stackSegments(values: number[]): StackSegment[] {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  if (total <= 0) return [];
  const out: StackSegment[] = [];
  let acc = 0;
  values.forEach((raw, index) => {
    const value = Math.max(0, raw);
    if (value === 0) return;
    const startPct = (acc / total) * 100;
    acc += value;
    out.push({ index, value, startPct, widthPct: (value / total) * 100 });
  });
  return out;
}

// ── KPI number presentation ───────────────────────────────────────────────────
/**
 * Compact display for KPI values: 950 → "950", 12 340 → "12.3K", 4 500 000 →
 * "4.5M". Latin digits always (the ar catalog keeps Latin numerals — i18n law).
 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs < 10_000) return `${sign}${Math.round(abs).toLocaleString("en-US")}`;
  const units: Array<[number, string]> = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = abs / size;
      const digits = scaled >= 100 ? 0 : 1;
      return `${sign}${scaled.toFixed(digits).replace(/\.0$/, "")}${suffix}`;
    }
  }
  return `${sign}${Math.round(abs)}`;
}

export type Delta = { direction: "up" | "down" | "flat"; label: string };

/**
 * Week-over-week style delta chip: previous 0 & current > 0 → "up, +current";
 * both 0 → flat. Label is a signed compact number (screens add their own
 * i18n framing).
 */
export function computeDelta(current: number, previous: number): Delta {
  const diff = current - previous;
  if (diff === 0) return { direction: "flat", label: "±0" };
  const direction = diff > 0 ? "up" : "down";
  return { direction, label: `${diff > 0 ? "+" : "-"}${formatCompact(Math.abs(diff))}` };
}
