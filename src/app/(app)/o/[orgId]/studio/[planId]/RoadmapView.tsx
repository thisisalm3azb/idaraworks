"use client";

/**
 * H25E — the roadmap projection: the same schedule at month scale, one lane
 * per element kind (objectives, phases, deliverables, milestones, tasks) so
 * leadership sees shape and dates without task-level noise. Bars and diamonds
 * come from the engine's early dates; nothing here is typed in by hand.
 */
import { useMemo } from "react";
import type { StudioDict, WorkspacePayload } from "./StudioWorkspace";

const LANES = ["objective", "initiative", "project", "phase", "deliverable", "milestone", "task"];
const MONTH_PX = 140;

function monthStart(date: string): string {
  return date.slice(0, 7) + "-01";
}
function addMonths(ym: string, n: number): string {
  const d = new Date(ym + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

export function RoadmapView({
  payload,
  dict,
  criticalIds,
  selectedId,
  onSelect,
}: {
  payload: WorkspacePayload;
  dict: StudioDict;
  criticalIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const model = useMemo(() => {
    const items = payload.nodes.filter((n) => payload.schedule[n.id]);
    if (items.length === 0) return null;
    let min = "9999-12-31";
    let max = "0000-01-01";
    for (const n of items) {
      const s = payload.schedule[n.id]!;
      if (s.earlyStart < min) min = s.earlyStart;
      if (s.earlyFinish > max) max = s.earlyFinish;
    }
    const from = monthStart(min);
    const months: string[] = [];
    for (let m = from; m <= max; m = addMonths(m, 1)) months.push(m);
    const totalDays = daysBetween(from, addMonths(months[months.length - 1]!, 1));
    const pxPerDay = (months.length * MONTH_PX) / totalDays;
    const lanes = LANES.map((kind) => ({
      kind,
      items: items.filter((n) => n.nodeType === kind),
    })).filter((l) => l.items.length > 0);
    return { from, months, pxPerDay, lanes, width: months.length * MONTH_PX };
  }, [payload]);

  if (!model) return <p className="p-4 text-sm text-ink-muted">{dict.nothingScheduled}</p>;

  return (
    <div className="h-full overflow-auto" dir="ltr">
      <div style={{ width: model.width + 160, minWidth: "100%" }}>
        <div className="sticky top-0 z-10 flex border-b border-line bg-sunken text-[11px] text-ink-muted">
          <div className="w-40 shrink-0 px-2 leading-8">{dict.type}</div>
          {model.months.map((m) => (
            <div
              key={m}
              className="shrink-0 border-s border-line px-2 leading-8"
              style={{ width: MONTH_PX }}
            >
              {m.slice(0, 7)}
            </div>
          ))}
        </div>
        {model.lanes.map((lane) => (
          <div key={lane.kind} className="flex border-b border-line">
            <div className="w-40 shrink-0 px-2 py-2 text-xs font-medium text-ink">
              {dict.nodeTypes[lane.kind] ?? lane.kind}
              <span className="ms-1 text-ink-muted">({lane.items.length})</span>
            </div>
            <div className="relative flex-1" style={{ minHeight: 20 + lane.items.length * 26 }}>
              {model.months.map((m, i) => (
                <div
                  key={m}
                  className="absolute inset-y-0 border-s border-line/60"
                  style={{ left: i * MONTH_PX }}
                  aria-hidden
                />
              ))}
              {lane.items.map((n, i) => {
                const s = payload.schedule[n.id]!;
                const left = daysBetween(model.from, s.earlyStart) * model.pxPerDay;
                const width = Math.max(
                  (daysBetween(s.earlyStart, s.earlyFinish) + 1) * model.pxPerDay,
                  8,
                );
                const critical = criticalIds.has(n.id);
                const milestone = s.durationDays === 0;
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => onSelect(n.id)}
                    title={`${n.title} · ${s.earlyStart} → ${s.earlyFinish}`}
                    className={`absolute flex h-5 items-center truncate rounded px-1 text-[11px] leading-5 ${
                      milestone
                        ? "text-ink"
                        : critical
                          ? "bg-danger text-white"
                          : "bg-accent/80 text-white"
                    } ${selectedId === n.id ? "ring-2 ring-ink" : ""}`}
                    style={{
                      top: 10 + i * 26,
                      left,
                      width: milestone ? undefined : width,
                      maxWidth: milestone ? 220 : undefined,
                    }}
                  >
                    {milestone ? (
                      <span
                        className={`me-1 inline-block h-3 w-3 rotate-45 border-2 ${
                          critical ? "border-danger bg-danger-soft" : "border-accent bg-card"
                        }`}
                        aria-hidden
                      />
                    ) : null}
                    <span className="truncate">{n.title}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
