"use client";

/**
 * H25E — the workload projection: the SAME schedule spread over people and
 * weeks. Each scheduled activity's working days fall into the ISO weeks it
 * spans (over the org calendar the engine used); a cell over the week's
 * working-day capacity is overloaded. Unassigned work is a row of its own,
 * never dropped.
 */
import { useMemo } from "react";
import type { StudioDict, WorkspacePayload } from "./StudioWorkspace";

function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Monday of the ISO week containing `date`. */
function weekStart(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Mon = 0
  return addDays(date, -dow);
}

export function WorkloadView({
  payload,
  dict,
  selectedId,
  onSelect,
}: {
  payload: WorkspacePayload;
  dict: StudioDict;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { weeks, rows, capacity } = useMemo(() => {
    const isWorking = (d: string) => {
      const dow = new Date(d + "T00:00:00Z").getUTCDay();
      return (
        payload.calendar.workingWeekdays.includes(dow) &&
        !payload.calendar.holidays.some((h) => d >= h.start && d <= h.end)
      );
    };
    const scheduled = payload.nodes.filter((n) => payload.schedule[n.id]);
    if (scheduled.length === 0) {
      return { weeks: [] as string[], rows: [] as WorkRow[], capacity: new Map<string, number>() };
    }
    let min = "9999-12-31";
    let max = "0000-01-01";
    for (const n of scheduled) {
      const s = payload.schedule[n.id]!;
      if (s.earlyStart < min) min = s.earlyStart;
      if (s.earlyFinish > max) max = s.earlyFinish;
    }
    const weeks: string[] = [];
    for (let w = weekStart(min); w <= max; w = addDays(w, 7)) weeks.push(w);
    const capacity = new Map<string, number>();
    for (const w of weeks) {
      let c = 0;
      for (let i = 0; i < 7; i++) if (isWorking(addDays(w, i))) c++;
      capacity.set(w, c);
    }
    const byPerson = new Map<string, WorkRow>();
    for (const n of scheduled) {
      const s = payload.schedule[n.id]!;
      if (s.durationDays === 0) continue;
      const key = n.assigneeEmployeeId ?? "";
      const row = byPerson.get(key) ?? {
        key,
        name: n.assigneeName ?? (n.assigneeEmployeeId ? n.assigneeEmployeeId.slice(0, 8) : ""),
        cells: new Map<string, { days: number; items: string[] }>(),
        total: 0,
      };
      for (let d = s.earlyStart; d <= s.earlyFinish; d = addDays(d, 1)) {
        if (!isWorking(d)) continue;
        const w = weekStart(d);
        const cell = row.cells.get(w) ?? { days: 0, items: [] };
        cell.days += 1;
        if (!cell.items.includes(n.id)) cell.items.push(n.id);
        row.cells.set(w, cell);
        row.total += 1;
      }
      byPerson.set(key, row);
    }
    const rows = [...byPerson.values()].sort((a, b) =>
      a.key === "" ? 1 : b.key === "" ? -1 : a.name.localeCompare(b.name),
    );
    return { weeks, rows, capacity };
  }, [payload]);

  if (weeks.length === 0) {
    return <p className="p-4 text-sm text-ink-muted">{dict.nothingScheduled}</p>;
  }
  const titles = new Map(payload.nodes.map((n) => [n.id, n.title]));

  return (
    <div className="h-full overflow-auto p-2" dir="ltr">
      <table className="min-w-full border-separate border-spacing-1 text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-card px-2 text-start font-medium text-ink-muted">
              {dict.capacity.replace("{days}", String(Math.max(...[...capacity.values()], 0)))}
            </th>
            {weeks.map((w) => (
              <th key={w} className="min-w-14 px-1 text-center font-normal text-ink-muted">
                {w.slice(5)}
                <span className="block text-[10px]">/{capacity.get(w)}</span>
              </th>
            ))}
            <th className="px-2 text-end font-medium text-ink-muted">Σ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key || "unassigned"}>
              <th className="sticky left-0 z-10 max-w-40 truncate bg-card px-2 text-start font-medium text-ink">
                {r.key ? r.name : dict.unassigned}
              </th>
              {weeks.map((w) => {
                const cell = r.cells.get(w);
                const cap = capacity.get(w) ?? 0;
                const ratio = cell && cap > 0 ? cell.days / cap : 0;
                const toneCls =
                  !cell || cell.days === 0
                    ? "bg-sunken"
                    : ratio > 1
                      ? "bg-danger text-white"
                      : ratio >= 0.8
                        ? "bg-warning-soft text-ink"
                        : "bg-success-soft text-ink";
                const hasSelected = cell?.items.includes(selectedId ?? "") ?? false;
                return (
                  <td key={w} className="p-0">
                    <button
                      type="button"
                      onClick={() => cell?.items[0] && onSelect(cell.items[0])}
                      title={cell ? cell.items.map((id) => titles.get(id) ?? id).join(", ") : ""}
                      className={`min-h-9 w-full rounded ${toneCls} ${hasSelected ? "ring-2 ring-accent" : ""}`}
                    >
                      {cell?.days ? cell.days : ""}
                    </button>
                  </td>
                );
              })}
              <td className="px-2 text-end text-ink-muted">{r.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type WorkRow = {
  key: string;
  name: string;
  cells: Map<string, { days: number; items: string[] }>;
  total: number;
};
