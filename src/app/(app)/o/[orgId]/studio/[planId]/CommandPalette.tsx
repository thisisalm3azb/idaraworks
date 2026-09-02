"use client";

/**
 * H25C — search and commands in one place (Ctrl/Cmd+K). Finding an element
 * selects it in every view and centres the canvas on it; commands run the
 * same actions the buttons do. Keyboard first: arrows, Enter, Escape.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { StudioDict, WorkspacePayload } from "./StudioWorkspace";

export type Command = { id: string; label: string; hint?: string; run: () => void };

export function CommandPalette({
  open,
  onClose,
  payload,
  dict,
  commands,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  payload: WorkspacePayload;
  dict: StudioDict;
  commands: Command[];
  onPick: (nodeId: string) => void;
}) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    setQ("");
    setCursor(0);
  }
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const nodes = payload.nodes
      .filter(
        (n) =>
          needle.length > 0 &&
          (n.title.toLowerCase().includes(needle) ||
            (dict.nodeTypes[n.nodeType] ?? n.nodeType).toLowerCase().includes(needle)),
      )
      .slice(0, 12)
      .map((n) => ({
        id: `node:${n.id}`,
        label: n.title,
        hint: `${dict.nodeTypes[n.nodeType] ?? n.nodeType} · ${dict.statuses[n.statusCategory] ?? n.statusCategory}`,
        run: () => onPick(n.id),
      }));
    const cmds = commands.filter(
      (c) => needle.length === 0 || c.label.toLowerCase().includes(needle),
    );
    return [...nodes, ...cmds];
  }, [q, payload.nodes, dict, commands, onPick]);

  if (!open) return null;
  const active = Math.min(cursor, Math.max(items.length - 1, 0));

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 p-4 pt-[12vh]"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={dict.commands}
        className="w-full max-w-lg overflow-hidden rounded-lg border border-line bg-card shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const it = items[active];
              if (it) {
                it.run();
                onClose();
              }
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
          placeholder={dict.search}
          aria-label={dict.search}
          className="min-h-12 w-full border-b border-line bg-card px-4 text-sm text-ink outline-none"
        />
        <ul role="listbox" className="max-h-[50vh] overflow-y-auto py-1">
          {items.length === 0 ? (
            <li className="px-4 py-3 text-sm text-ink-muted">{dict.nothingFound}</li>
          ) : null}
          {items.map((it, i) => (
            <li key={it.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseEnter={() => setCursor(i)}
                onClick={() => {
                  it.run();
                  onClose();
                }}
                className={`flex min-h-10 w-full items-center justify-between gap-3 px-4 text-start text-sm ${
                  i === active ? "bg-sunken text-ink" : "text-ink"
                }`}
              >
                <span className="truncate">{it.label}</span>
                {it.hint ? (
                  <span className="shrink-0 text-[11px] text-ink-muted">{it.hint}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
