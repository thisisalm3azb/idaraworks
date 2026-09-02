"use client";

/**
 * H25E/H — the workload projection: the capacity report (the SAME schedule
 * spread over people and ISO weeks through their canonical allocations) as a
 * heat table. A cell over the week's working-day capacity is overloaded.
 * Unassigned work is a row of its own, never dropped. "Level" never moves
 * work: it records a proposal as a scenario for review.
 */
import { useState, useTransition } from "react";
import type { ActionResult } from "../actions";
import type { StudioActions, StudioDict, WorkspacePayload } from "./StudioWorkspace";

export function WorkloadView({
  payload,
  dict,
  actions,
  selectedId,
  onSelect,
  settle,
  onOpenScenario,
}: {
  payload: WorkspacePayload;
  dict: StudioDict;
  actions: StudioActions;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  settle: (res: ActionResult<unknown>, okText?: string) => boolean;
  onOpenScenario: (id: string | null) => void;
}) {
  const [pending, start] = useTransition();
  const [levelName, setLevelName] = useState(dict.levelName);
  const cap = payload.capacity;
  if (cap.weeks.length === 0) {
    return <p className="p-4 text-sm text-ink-muted">{dict.nothingScheduled}</p>;
  }
  const unassignedWeeks = cap.weeks.filter((w) => cap.unassigned[w]);
  const maxCapacity = Math.max(
    ...cap.people.flatMap((p) => cap.weeks.map((w) => p.cells[w]?.capacityDays ?? 0)),
    0,
  );

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`rounded-full px-2 py-0.5 ${
            cap.overloads.length > 0 ? "bg-danger-soft text-danger" : "bg-success-soft text-success"
          }`}
        >
          {dict.overloads.replace("{count}", String(cap.overloads.length))}
        </span>
        {cap.warnings.includes("people withheld") ? (
          <span className="text-ink-muted">{dict.peopleWithheld}</span>
        ) : null}
        {cap.overloads.length > 0 && payload.canManageScenario && !payload.scenarioId ? (
          <form
            className="ms-auto flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const res = await actions.level({
                  planId: payload.planId,
                  name: levelName.trim() || dict.levelName,
                });
                if (settle(res) && res.ok) onOpenScenario(res.data.scenarioId);
              });
            }}
          >
            <input
              value={levelName}
              onChange={(e) => setLevelName(e.target.value)}
              maxLength={200}
              className="min-h-9 rounded-md border border-line-strong bg-card px-2 text-xs text-ink"
            />
            <button
              type="submit"
              disabled={pending}
              className="min-h-9 rounded-md bg-accent px-3 text-xs font-medium text-white disabled:opacity-50"
            >
              {dict.level}
            </button>
          </form>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto" dir="ltr">
        <table className="min-w-full border-separate border-spacing-1 text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-card px-2 text-start font-medium text-ink-muted">
                {dict.capacity.replace("{days}", String(maxCapacity))}
              </th>
              {cap.weeks.map((w) => (
                <th key={w} className="min-w-14 px-1 text-center font-normal text-ink-muted">
                  {w.slice(5)}
                </th>
              ))}
              <th className="px-2 text-end font-medium text-ink-muted">Σ</th>
            </tr>
          </thead>
          <tbody>
            {cap.people.map((p) => (
              <tr key={p.employeeId}>
                <th className="sticky left-0 z-10 max-w-44 bg-card px-2 text-start font-medium text-ink">
                  <span className="block truncate">{p.name}</span>
                  <span className="block truncate text-[10px] font-normal text-ink-muted">
                    {[p.teamName, ...p.skills].filter(Boolean).join(" · ")}
                  </span>
                </th>
                {cap.weeks.map((w) => {
                  const cell = p.cells[w];
                  const demand = cell?.demandDays ?? 0;
                  const capacity = cell?.capacityDays ?? 0;
                  const ratio = capacity > 0 ? demand / capacity : demand > 0 ? 2 : 0;
                  const toneCls =
                    demand === 0
                      ? "bg-sunken"
                      : ratio > 1
                        ? "bg-danger text-white"
                        : ratio >= 0.8
                          ? "bg-warning-soft text-ink"
                          : "bg-success-soft text-ink";
                  const hasSelected = cell?.items.some((i) => i.nodeId === selectedId) ?? false;
                  return (
                    <td key={w} className="p-0">
                      <button
                        type="button"
                        onClick={() => cell?.items[0] && onSelect(cell.items[0].nodeId)}
                        title={
                          cell
                            ? cell.items
                                .map(
                                  (i) =>
                                    `${i.title} (${Math.round(i.share * 100)}%${i.implicit ? `, ${dict.implicit}` : ""})`,
                                )
                                .join("\n")
                            : ""
                        }
                        className={`min-h-9 w-full rounded ${toneCls} ${hasSelected ? "ring-2 ring-accent" : ""}`}
                      >
                        {demand ? `${demand}/${capacity}` : ""}
                      </button>
                    </td>
                  );
                })}
                <td className="px-2 text-end text-ink-muted">
                  {p.totalDemand}/{p.totalCapacity}
                </td>
              </tr>
            ))}
            {unassignedWeeks.length > 0 ? (
              <tr>
                <th className="sticky left-0 z-10 bg-card px-2 text-start font-medium text-ink">
                  {dict.unassigned}
                </th>
                {cap.weeks.map((w) => {
                  const cell = cap.unassigned[w];
                  return (
                    <td key={w} className="p-0">
                      <button
                        type="button"
                        onClick={() => cell?.items[0] && onSelect(cell.items[0].nodeId)}
                        title={cell ? cell.items.map((i) => i.title).join("\n") : ""}
                        className={`min-h-9 w-full rounded ${
                          cell
                            ? "border border-dashed border-line-strong bg-card text-ink"
                            : "bg-sunken"
                        }`}
                      >
                        {cell ? cell.demandDays : ""}
                      </button>
                    </td>
                  );
                })}
                <td className="px-2 text-end text-ink-muted">
                  {unassignedWeeks.reduce((s, w) => s + (cap.unassigned[w]?.demandDays ?? 0), 0)}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
