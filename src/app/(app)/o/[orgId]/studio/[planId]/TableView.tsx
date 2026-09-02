"use client";

/**
 * H25E — the table projection: the same nodes, as rows. It is also the
 * accessible equivalent of the canvas (every canvas fact has a cell here).
 */
import type { StudioDict, WorkspacePayload } from "./StudioWorkspace";

export function TableView({
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
  const rows = [...payload.nodes].sort((a, b) => {
    const sa = payload.schedule[a.id]?.earlyStart ?? a.startDate ?? "9999";
    const sb = payload.schedule[b.id]?.earlyStart ?? b.startDate ?? "9999";
    return sa < sb ? -1 : sa > sb ? 1 : a.title.localeCompare(b.title);
  });
  return (
    <div className="h-full overflow-auto">
      <table className="w-full min-w-[40rem] text-sm">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b border-line text-xs text-ink-muted">
            <th className="px-3 py-2 text-start">{dict.title}</th>
            <th className="px-3 py-2 text-start">{dict.type}</th>
            <th className="px-3 py-2 text-start">{dict.status}</th>
            <th className="px-3 py-2 text-start">{dict.startDate}</th>
            <th className="px-3 py-2 text-start">{dict.dueDate}</th>
            <th className="px-3 py-2 text-end">{dict.duration}</th>
            <th className="px-3 py-2 text-end">float</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => {
            const s = payload.schedule[n.id];
            const critical = criticalIds.has(n.id);
            return (
              <tr
                key={n.id}
                onClick={() => onSelect(n.id)}
                className={`cursor-pointer border-b border-line last:border-0 hover:bg-sunken ${
                  selectedId === n.id ? "bg-sunken" : ""
                }`}
              >
                <td className="px-3 py-2 text-ink">
                  {n.title}
                  {n.recordId ? (
                    <span className="ms-1 text-accent" aria-label={dict.linked}>
                      ●
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-ink-muted">
                  {dict.nodeTypes[n.nodeType] ?? n.nodeType}
                </td>
                <td className="px-3 py-2">{dict.statuses[n.statusCategory] ?? n.statusCategory}</td>
                <td className="px-3 py-2" dir="ltr">
                  {s?.earlyStart ?? n.startDate ?? ""}
                </td>
                <td className="px-3 py-2" dir="ltr">
                  {s?.earlyFinish ?? n.dueDate ?? ""}
                </td>
                <td className="px-3 py-2 text-end" dir="ltr">
                  {s?.durationDays ?? n.durationDays ?? ""}
                </td>
                <td
                  className={`px-3 py-2 text-end ${critical ? "font-semibold text-danger" : ""}`}
                  dir="ltr"
                >
                  {s ? `${s.totalFloatDays}${critical ? ` · ${dict.critical}` : ""}` : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {payload.unscheduled.length > 0 ? (
        <div className="border-t border-line p-3 text-xs text-ink-muted">
          <p className="font-semibold text-ink">{dict.unscheduled}</p>
          <ul>
            {payload.unscheduled.map((u) => (
              <li key={u.nodeId}>
                {u.title}: {u.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
