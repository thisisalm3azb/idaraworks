"use client";

import { useId, useState } from "react";
import { areaPath, linePath, niceMax, scaleSeries, ticks } from "./geometry";

export type TrendPoint = {
  /** Short x label, e.g. "Mon 3" or "07-01". */
  label: string;
  value: number;
  /** Pre-formatted display value (money stays formatted by the server). */
  display?: string;
};

/**
 * Hand-rolled SVG trend chart (line + soft area, or bars) with hover/keyboard
 * tooltips (U5 §3 — NO chart library). Accessible: role="img" with a summary
 * label, arrow-key point traversal, values readable via the tooltip text.
 * Direction: the plot itself stays LTR (a time axis is a number line) — the
 * container is dir="ltr" per the numbers law; captions around it flip normally.
 */
export function TrendChart({
  points,
  title,
  kind = "line",
  height = 140,
}: {
  points: TrendPoint[];
  /** Accessible one-line summary, e.g. "Reports submitted, last 14 days". */
  title: string;
  kind?: "line" | "bar";
  height?: number;
}) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  const width = 320; // viewBox units; scales to container width
  const pad = 8;
  const values = points.map((p) => p.value);
  const max = niceMax(Math.max(0, ...values));
  const scaled = scaleSeries(values, width, height, pad);
  const gridYs = ticks(Math.max(0, ...values), 3).map(
    (v) => pad + (height - pad * 2) * (1 - v / max),
  );
  const activePoint = active !== null ? points[active] : null;
  const activePos = active !== null ? scaled[active] : null;

  const move = (delta: number) => {
    if (points.length === 0) return;
    setActive((prev) => {
      const next = prev === null ? points.length - 1 : prev + delta;
      return Math.min(points.length - 1, Math.max(0, next));
    });
  };

  if (points.length === 0) return null;
  const barW = Math.max(3, (width - pad * 2) / Math.max(1, points.length) - 3);

  return (
    <div dir="ltr" className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block h-auto w-full"
        role="img"
        aria-labelledby={`${id}-title`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Escape") {
            setActive(null);
          }
        }}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * width;
          let best = 0;
          scaled.forEach((p, i) => {
            if (Math.abs(p.x - x) < Math.abs(scaled[best]!.x - x)) best = i;
          });
          setActive(best);
        }}
      >
        <title id={`${id}-title`}>{title}</title>
        {gridYs.map((y, i) => (
          <line
            key={i}
            x1={pad}
            x2={width - pad}
            y1={y}
            y2={y}
            stroke="var(--border)"
            strokeWidth={1}
          />
        ))}
        {kind === "bar" ? (
          scaled.map((p, i) => (
            <rect
              key={i}
              x={p.x - barW / 2}
              y={p.y}
              width={barW}
              height={Math.max(0, height - pad - p.y)}
              rx={1.5}
              fill={i === active ? "var(--accent)" : "var(--accent-line)"}
            />
          ))
        ) : (
          <>
            <path d={areaPath(scaled, height - pad)} fill="var(--accent-soft)" />
            <path
              d={linePath(scaled)}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={2}
              strokeLinejoin="round"
            />
            {activePos ? (
              <circle
                cx={activePos.x}
                cy={activePos.y}
                r={3.5}
                fill="var(--accent)"
                stroke="var(--surface-card)"
                strokeWidth={1.5}
              />
            ) : null}
          </>
        )}
        {activePos ? (
          <line
            x1={activePos.x}
            x2={activePos.x}
            y1={pad}
            y2={height - pad}
            stroke="var(--border-strong)"
            strokeDasharray="3 3"
            strokeWidth={1}
          />
        ) : null}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-muted">
        <span>{points[0]!.label}</span>
        <span>{points[points.length - 1]!.label}</span>
      </div>
      {activePoint && activePos ? (
        <div
          className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-card px-2 py-1 text-xs shadow-pop"
          style={{ left: `${(activePos.x / width) * 100}%` }}
          role="status"
        >
          <span className="text-ink-muted">{activePoint.label}</span>{" "}
          <span className="font-mono font-semibold text-ink">
            {activePoint.display ?? activePoint.value.toLocaleString("en-US")}
          </span>
        </div>
      ) : null}
    </div>
  );
}
