"use client";

/**
 * H25E — the Gantt projection. Bars come from the schedule bridge (early
 * dates over the org calendar); the time axis is calendar days so the eye
 * sees weekends, while durations stay in WORKING days. Dragging a bar
 * commits a new start through the ONE update path (a linked task's real
 * start date moves); dependency links are drawn from the same edges the
 * engine used; the critical chain is whatever the engine computed.
 */
import { useMemo, useRef, useState } from "react";
import type { ActionResult } from "../actions";
import type { StudioActions, StudioDict, WorkspacePayload } from "./StudioWorkspace";

const DAY_PX = 28;
const ROW_H = 36;

function dayIndex(from: string, date: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}
function addDaysIso(date: string, n: number): string {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function GanttView({
  payload,
  dict,
  actions,
  criticalIds,
  selectedId,
  onSelect,
  settle,
}: {
  payload: WorkspacePayload;
  dict: StudioDict;
  actions: StudioActions;
  criticalIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  settle: (res: ActionResult<unknown>, okText?: string) => boolean;
}) {
  const rows = useMemo(
    () =>
      payload.nodes
        .filter((n) => payload.schedule[n.id])
        .sort((a, b) => {
          const sa = payload.schedule[a.id]!.earlyStart;
          const sb = payload.schedule[b.id]!.earlyStart;
          return sa < sb ? -1 : sa > sb ? 1 : a.title.localeCompare(b.title);
        }),
    [payload],
  );
  const from = payload.projectStart ?? rows[0]?.startDate ?? null;
  const to = payload.projectFinish ?? null;
  const totalDays = from && to ? Math.max(dayIndex(from, to) + 1, 7) : 0;
  const rowIndex = useMemo(() => new Map(rows.map((n, i) => [n.id, i])), [rows]);
  const [drag, setDrag] = useState<{ id: string; startX: number; deltaDays: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  if (!from || !to || rows.length === 0) {
    return (
      <div className="p-4 text-sm text-ink-muted">
        {dict.unscheduled}
        <ul className="mt-2 list-disc ps-5">
          {payload.unscheduled.map((u) => (
            <li key={u.nodeId}>
              {u.title}: {u.reason}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const days = Array.from({ length: totalDays }, (_, i) => addDaysIso(from, i));

  function onPointerDown(e: React.PointerEvent, id: string) {
    if (!payload.canManage) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id, startX: e.clientX, deltaDays: 0 });
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const delta = Math.round((e.clientX - drag.startX) / DAY_PX);
    if (delta !== drag.deltaDays) setDrag({ ...drag, deltaDays: delta });
  }
  async function onPointerUp() {
    if (!drag) return;
    const { id, deltaDays } = drag;
    setDrag(null);
    if (deltaDays === 0) return;
    const node = payload.nodes.find((n) => n.id === id);
    const sched = payload.schedule[id];
    if (!node || !sched) return;
    const res = await actions.updateNode({
      nodeId: id,
      expectedRowVersion: node.rowVersion,
      ...(payload.scenarioId ? { scenarioId: payload.scenarioId } : {}),
      startDate: addDaysIso(sched.earlyStart, deltaDays),
      ...(node.durationDays === null ? { durationDays: sched.durationDays } : {}),
    });
    settle(res);
  }

  return (
    <div className="flex h-full" dir="ltr">
      <div className="w-[220px] shrink-0 overflow-hidden border-e border-line">
        <div className="h-9 border-b border-line bg-sunken px-3 text-xs leading-9 text-ink-muted">
          {dict.title}
        </div>
        {rows.map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => onSelect(n.id)}
            className={`block w-full truncate border-b border-line px-3 text-start text-sm text-ink ${
              selectedId === n.id ? "bg-sunken" : ""
            }`}
            style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}
            title={n.title}
          >
            {criticalIds.has(n.id) ? <span className="me-1 text-danger">●</span> : null}
            {n.title}
          </button>
        ))}
      </div>
      <div
        ref={scrollRef}
        className="relative flex-1 overflow-auto"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
      >
        <div style={{ width: totalDays * DAY_PX, minWidth: "100%" }}>
          <div className="sticky top-0 z-10 flex h-9 border-b border-line bg-sunken text-[10px] text-ink-muted">
            {days.map((d) => {
              const dow = new Date(d + "T00:00:00Z").getUTCDay();
              const weekend = dow === 5 || dow === 6;
              return (
                <div
                  key={d}
                  className={`shrink-0 border-e border-line px-1 leading-9 ${weekend ? "bg-line/40" : ""}`}
                  style={{ width: DAY_PX }}
                  title={d}
                >
                  {d.slice(8, 10) === "01" || d === from ? d.slice(5) : d.slice(8, 10)}
                </div>
              );
            })}
          </div>
          <div className="relative" style={{ height: rows.length * ROW_H }}>
            <svg
              className="pointer-events-none absolute inset-0"
              width={totalDays * DAY_PX}
              height={rows.length * ROW_H}
              aria-hidden
            >
              {payload.edges
                .filter((e) => e.edgeType === "dependency")
                .map((e) => {
                  const s = payload.schedule[e.sourceNodeId];
                  const t = payload.schedule[e.targetNodeId];
                  const ri = rowIndex.get(e.sourceNodeId);
                  const rj = rowIndex.get(e.targetNodeId);
                  if (!s || !t || ri === undefined || rj === undefined) return null;
                  const x1 = (dayIndex(from, s.earlyFinish) + 1) * DAY_PX;
                  const y1 = ri * ROW_H + ROW_H / 2;
                  const x2 = dayIndex(from, t.earlyStart) * DAY_PX;
                  const y2 = rj * ROW_H + ROW_H / 2;
                  const critical =
                    criticalIds.has(e.sourceNodeId) && criticalIds.has(e.targetNodeId);
                  return (
                    <path
                      key={e.id}
                      d={`M ${x1} ${y1} L ${x1 + 6} ${y1} L ${x1 + 6} ${y2} L ${x2} ${y2}`}
                      fill="none"
                      stroke={critical ? "#b3261e" : "#9aa8a2"}
                      strokeWidth={critical ? 2 : 1}
                    />
                  );
                })}
            </svg>
            {rows.map((n, i) => {
              const s = payload.schedule[n.id]!;
              const critical = criticalIds.has(n.id);
              const startIdx =
                dayIndex(from, s.earlyStart) + (drag?.id === n.id ? drag.deltaDays : 0);
              const span = s.durationDays === 0 ? 0 : dayIndex(s.earlyStart, s.earlyFinish) + 1;
              const milestone = s.durationDays === 0;
              return (
                <div
                  key={n.id}
                  className="absolute"
                  style={{ top: i * ROW_H + 8, left: startIdx * DAY_PX, height: ROW_H - 16 }}
                >
                  {milestone ? (
                    <button
                      type="button"
                      onClick={() => onSelect(n.id)}
                      onPointerDown={(e) => onPointerDown(e, n.id)}
                      aria-label={`${n.title} ${dict.milestone}`}
                      className={`h-5 w-5 rotate-45 border-2 ${critical ? "border-danger bg-danger-soft" : "border-accent bg-card"} ${
                        selectedId === n.id ? "ring-2 ring-accent" : ""
                      }`}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSelect(n.id)}
                      onPointerDown={(e) => onPointerDown(e, n.id)}
                      className={`h-full truncate rounded-md px-2 text-start text-[11px] leading-5 shadow-sm ${
                        critical ? "bg-danger text-white" : "bg-accent/85 text-white"
                      } ${selectedId === n.id ? "ring-2 ring-ink" : ""} ${
                        payload.canManage ? "cursor-grab active:cursor-grabbing" : ""
                      }`}
                      style={{ width: Math.max(span * DAY_PX - 4, 12) }}
                      title={`${s.earlyStart} → ${s.earlyFinish} · ${s.durationDays}d · float ${s.totalFloatDays}`}
                    >
                      {n.title}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
