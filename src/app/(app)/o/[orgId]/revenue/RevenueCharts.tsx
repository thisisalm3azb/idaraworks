"use client";

/**
 * H27 — the studio's charts: plain SVG bars (no library, no animation),
 * loaded lazily by LazyCharts so the hub's first paint is the numbers.
 * Money is passed in already formatted (redaction happened on the server).
 */
export type Bar = {
  key: string;
  label: string;
  count: number;
  value: number;
  valueText: string | null;
};

export function RevenueCharts({
  stages,
  months,
  labels,
}: {
  stages: Bar[];
  months: Bar[];
  labels: { stages: string; months: string; count: string; none: string };
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <BarChart title={labels.stages} bars={stages} countLabel={labels.count} none={labels.none} />
      <BarChart title={labels.months} bars={months} countLabel={labels.count} none={labels.none} />
    </div>
  );
}

function BarChart({
  title,
  bars,
  countLabel,
  none,
}: {
  title: string;
  bars: Bar[];
  countLabel: string;
  none: string;
}) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const rowH = 28;
  const h = Math.max(1, bars.length) * rowH;
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-sm font-semibold text-ink">{title}</figcaption>
      {bars.length === 0 ? (
        <p className="text-sm text-ink-muted">{none}</p>
      ) : (
        <svg
          viewBox={`0 0 400 ${h}`}
          width="100%"
          height={h}
          role="img"
          aria-label={title}
          className="text-ink"
        >
          {bars.map((b, i) => {
            const w = Math.max(2, Math.round((b.value / max) * 240));
            const y = i * rowH;
            return (
              <g key={b.key} transform={`translate(0 ${y})`}>
                <text x="0" y="18" fontSize="12" fill="currentColor">
                  {b.label.length > 18 ? `${b.label.slice(0, 17)}…` : b.label}
                </text>
                <rect x="130" y="6" width={w} height="16" rx="3" className="fill-brand" />
                <text
                  x={130 + w + 6}
                  y="18"
                  fontSize="11"
                  fill="currentColor"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {b.valueText ?? `${b.count} ${countLabel}`}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </figure>
  );
}
