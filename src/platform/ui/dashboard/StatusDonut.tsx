import Link from "next/link";
import { donutSegments } from "./geometry";
import { seriesColor } from "./palette";

export type DonutDatum = {
  key: string;
  label: string;
  value: number;
  /** Segment/legend rows link to their filtered view when provided. */
  href?: string;
  /** Explicit CSS colour var; defaults to the series palette by index. */
  color?: string;
};

/**
 * Server-rendered SVG donut + legend (U5 §3). No hover dependence — every
 * value is in the legend (a11y + touch), the ring is the shape summary.
 */
export function StatusDonut({
  data,
  centerLabel,
  title,
}: {
  data: DonutDatum[];
  /** Big number in the middle (usually the total), dir="ltr". */
  centerLabel?: string;
  title: string;
}) {
  const size = 120;
  const c = size / 2;
  const r = 46;
  const segments = donutSegments(
    data.map((d) => d.value),
    c,
    r,
  );
  const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div dir="ltr" className="relative shrink-0">
        <svg
          viewBox={`0 0 ${size} ${size}`}
          width={size}
          height={size}
          role="img"
          aria-label={title}
        >
          <circle cx={c} cy={c} r={r} fill="none" stroke="var(--surface-sunken)" strokeWidth={14} />
          {segments.map((s) => (
            <path
              key={s.index}
              d={s.path}
              fill="none"
              stroke={data[s.index]!.color ?? seriesColor(s.index)}
              strokeWidth={14}
              strokeLinecap="butt"
            />
          ))}
        </svg>
        {centerLabel ? (
          <span className="absolute inset-0 flex items-center justify-center font-mono text-xl font-semibold text-ink">
            {centerLabel}
          </span>
        ) : null}
      </div>
      <ul className="min-w-0 flex-1 text-sm">
        {data.map((d, i) => {
          const row = (
            <span className="flex min-h-8 items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: d.color ?? seriesColor(i) }}
                />
                <span className="truncate text-ink">{d.label}</span>
              </span>
              <span dir="ltr" className="font-mono text-ink-secondary">
                {d.value.toLocaleString("en-US")}
                {total > 0 ? (
                  <span className="ms-1 text-xs text-ink-muted">
                    {Math.round((Math.max(0, d.value) / total) * 100)}%
                  </span>
                ) : null}
              </span>
            </span>
          );
          return (
            <li key={d.key}>
              {d.href ? (
                <Link href={d.href} className="block rounded-sm hover:bg-sunken">
                  {row}
                </Link>
              ) : (
                row
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
