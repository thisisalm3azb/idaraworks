import Link from "next/link";
import { stackSegments } from "./geometry";
import { seriesColor } from "./palette";

export type DistributionDatum = {
  key: string;
  label: string;
  value: number;
  href?: string;
  color?: string;
};

/**
 * Stage/status distribution (U5 §3): one stacked bar + legend rows that link
 * to the segment's filtered view. Logical properties only — the bar direction
 * follows the document direction naturally (percent offsets are symmetric).
 */
export function DistributionBar({ data, title }: { data: DistributionDatum[]; title: string }) {
  const segments = stackSegments(data.map((d) => d.value));
  return (
    <div>
      <div
        role="img"
        aria-label={title}
        className="flex h-3 w-full overflow-hidden rounded-full bg-sunken"
      >
        {segments.map((s) => (
          <span
            key={data[s.index]!.key}
            style={{
              width: `${s.widthPct}%`,
              backgroundColor: data[s.index]!.color ?? seriesColor(s.index),
            }}
          />
        ))}
      </div>
      <ul className="mt-3 flex flex-col text-sm">
        {data.map((d, i) => {
          const row = (
            <span className="flex min-h-9 items-center justify-between gap-2">
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
              </span>
            </span>
          );
          return (
            <li key={d.key}>
              {d.href ? (
                <Link href={d.href} className="block rounded-sm px-1 hover:bg-sunken">
                  {row}
                </Link>
              ) : (
                <span className="block px-1">{row}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
