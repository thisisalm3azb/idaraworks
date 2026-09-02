"use client";

/**
 * H25E — the calendar projection: a month grid over the org calendar (the
 * engine's non-working days shaded), each scheduled element shown on its
 * finish day (milestones on their day). Same schedule, different eye.
 */
import { useMemo, useState } from "react";
import type { StudioDict, WorkspacePayload } from "./StudioWorkspace";

function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function ym(date: string): string {
  return date.slice(0, 7);
}
function shiftMonth(month: string, n: number): string {
  const d = new Date(month + "-01T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}

export function CalendarView({
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
  const today = new Date().toISOString().slice(0, 10);
  const [month, setMonth] = useState(ym(payload.projectStart ?? today));

  const cells = useMemo(() => {
    const first = month + "-01";
    const firstDow = (new Date(first + "T00:00:00Z").getUTCDay() + 6) % 7; // Mon-first
    const start = addDays(first, -firstDow);
    const out: Array<{ date: string; inMonth: boolean; working: boolean; items: string[] }> = [];
    const byFinish = new Map<string, string[]>();
    for (const n of payload.nodes) {
      const s = payload.schedule[n.id];
      if (!s) continue;
      const list = byFinish.get(s.earlyFinish) ?? [];
      list.push(n.id);
      byFinish.set(s.earlyFinish, list);
    }
    for (let i = 0; i < 42; i++) {
      const date = addDays(start, i);
      const dow = new Date(date + "T00:00:00Z").getUTCDay();
      const working =
        payload.calendar.workingWeekdays.includes(dow) &&
        !payload.calendar.holidays.some((h) => date >= h.start && date <= h.end);
      out.push({ date, inMonth: ym(date) === month, working, items: byFinish.get(date) ?? [] });
    }
    return out;
  }, [month, payload]);

  const titles = new Map(payload.nodes.map((n) => [n.id, n.title]));

  return (
    <div className="flex h-full flex-col p-2" dir="ltr">
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setMonth(shiftMonth(month, -1))}
          className="min-h-9 min-w-9 rounded-md border border-line text-ink"
          aria-label="previous month"
        >
          ‹
        </button>
        <span className="text-sm font-medium text-ink">{month}</span>
        <button
          type="button"
          onClick={() => setMonth(shiftMonth(month, 1))}
          className="min-h-9 min-w-9 rounded-md border border-line text-ink"
          aria-label="next month"
        >
          ›
        </button>
        <button
          type="button"
          onClick={() => setMonth(ym(today))}
          className="min-h-9 rounded-md border border-line px-2 text-xs text-ink"
        >
          {dict.today}
        </button>
      </div>
      <div className="grid flex-1 grid-cols-7 gap-1 overflow-auto">
        {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => (
          <div key={d} className="text-center text-[10px] uppercase text-ink-muted">
            {d}
          </div>
        ))}
        {cells.map((c) => (
          <div
            key={c.date}
            className={`min-h-16 rounded-md border p-1 ${
              c.inMonth ? "border-line" : "border-transparent opacity-50"
            } ${c.working ? "bg-card" : "bg-line/40"} ${c.date === today ? "ring-1 ring-accent" : ""}`}
          >
            <span className="block text-[10px] text-ink-muted">{c.date.slice(8)}</span>
            {c.items.slice(0, 3).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => onSelect(id)}
                className={`mt-0.5 block w-full truncate rounded px-1 text-start text-[10px] ${
                  criticalIds.has(id) ? "bg-danger text-white" : "bg-accent/80 text-white"
                } ${selectedId === id ? "ring-2 ring-ink" : ""}`}
              >
                {titles.get(id) ?? id}
              </button>
            ))}
            {c.items.length > 3 ? (
              <span className="block text-[10px] text-ink-muted">+{c.items.length - 3}</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
