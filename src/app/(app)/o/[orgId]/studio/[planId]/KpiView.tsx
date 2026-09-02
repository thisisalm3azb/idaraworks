"use client";

/**
 * H25J — the indicators projection: every catalogue KPI for this plan with
 * its live value or an honest "insufficient" and the basis it is computed
 * on. A list, not a card grid; the number is never separated from its basis.
 */
import type { StudioDict, WorkspacePayload } from "./StudioWorkspace";

function fmt(v: number | string, unit: string): string {
  if (typeof v === "string") return v;
  if (unit === "percent") return `${v}%`;
  return String(v);
}

export function KpiView({ payload, dict }: { payload: WorkspacePayload; dict: StudioDict }) {
  return (
    <div className="h-full overflow-auto p-3">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-start text-[11px] uppercase tracking-wide text-ink-muted">
            <th className="px-2 py-1 text-start font-medium">{dict.kpiName}</th>
            <th className="px-2 py-1 text-end font-medium">{dict.kpiValue}</th>
            <th className="hidden px-2 py-1 text-start font-medium md:table-cell">
              {dict.kpiBasis}
            </th>
          </tr>
        </thead>
        <tbody>
          {payload.kpis.map((k) => (
            <tr key={k.key} className="border-t border-line align-top">
              <td className="px-2 py-2">
                <span className="block text-ink">{dict.kpiNames[k.key] ?? k.key}</span>
                <span className="block text-[11px] text-ink-muted md:hidden">{k.basis}</span>
              </td>
              <td className="px-2 py-2 text-end" dir="ltr">
                {k.status === "ok" ? (
                  <span className="font-medium tabular-nums text-ink">{fmt(k.value, k.unit)}</span>
                ) : (
                  <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] text-warning">
                    {dict.kpiInsufficient}: {k.reason}
                  </span>
                )}
                <span className="ms-1 text-[11px] text-ink-muted">
                  {k.status === "ok" && k.unit !== "date" && k.unit !== "percent" ? k.unit : ""}
                </span>
              </td>
              <td className="hidden px-2 py-2 text-[11px] text-ink-muted md:table-cell">
                {k.basis}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
