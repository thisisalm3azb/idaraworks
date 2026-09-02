"use client";

/**
 * H26M — search and commands for the document estate in one place
 * (Ctrl/Cmd+K, or the button). Documents by reference or title, plus the
 * places a person goes next. Keyboard first: arrows, Enter, Escape. No
 * animation, so reduced-motion users get the same experience as everyone.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type PaletteDict = {
  open: string;
  placeholder: string;
  nothing: string;
  commands: string;
  documents: string;
  shortcut: string;
};

export type PaletteCommand = { id: string; label: string; hint?: string; href: string };

export function DocCommandPalette({
  rows,
  commands,
  statusLabels,
  orgId,
  dict,
}: {
  rows: Array<{ id: string; reference: string; title: string; effectiveStatus: string }>;
  commands: PaletteCommand[];
  statusLabels: Record<string, string>;
  orgId: string;
  dict: PaletteDict;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQ("");
        setCursor(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const docs = rows
      .filter(
        (r) =>
          needle.length > 0 &&
          (r.reference.toLowerCase().includes(needle) || r.title.toLowerCase().includes(needle)),
      )
      .slice(0, 10)
      .map((r) => ({
        id: `doc:${r.id}`,
        label: `${r.reference} · ${r.title}`,
        hint: statusLabels[r.effectiveStatus] ?? r.effectiveStatus,
        href: `/o/${orgId}/documents/${r.id}`,
      }));
    const cmds = commands.filter(
      (c) => needle.length === 0 || c.label.toLowerCase().includes(needle),
    );
    return [...docs, ...cmds];
  }, [q, rows, commands, statusLabels, orgId]);

  const active = Math.min(cursor, Math.max(items.length - 1, 0));
  const go = (i: number) => {
    const it = items[i];
    if (!it) return;
    setOpen(false);
    router.push(it.href);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setQ("");
          setCursor(0);
        }}
        className="inline-flex min-h-9 items-center gap-2 rounded-md border border-line bg-card px-3 text-sm text-ink-secondary hover:bg-sunken"
        aria-haspopup="dialog"
        data-palette-trigger
      >
        {dict.open}
        <kbd className="rounded border border-line px-1 text-[10px] text-ink-muted">
          {dict.shortcut}
        </kbd>
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 p-4 pt-[12vh]"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={dict.commands}
            className="w-full max-w-lg overflow-hidden rounded-lg border border-line bg-card shadow-lg"
            onClick={(e) => e.stopPropagation()}
            data-palette
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
                  go(active);
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
              placeholder={dict.placeholder}
              className="min-h-12 w-full border-b border-line bg-card px-4 text-base text-ink outline-none"
              aria-activedescendant={items[active] ? `pal-${items[active].id}` : undefined}
            />
            <ul role="listbox" className="max-h-80 overflow-y-auto py-1">
              {items.length === 0 ? (
                <li className="px-4 py-3 text-sm text-ink-muted">{dict.nothing}</li>
              ) : null}
              {items.map((it, i) => (
                <li
                  key={it.id}
                  id={`pal-${it.id}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => go(i)}
                  className={`flex cursor-pointer items-center justify-between gap-3 px-4 py-2 text-sm ${i === active ? "bg-sunken text-ink" : "text-ink-secondary"}`}
                >
                  <span className="truncate">{it.label}</span>
                  {it.hint ? (
                    <span className="shrink-0 text-xs text-ink-muted">{it.hint}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
