"use client";

/**
 * H27 — the studio's command centre (Ctrl/Cmd+K or the button): places to
 * go, plus a database-side search across leads, opportunities and customers
 * through one server action (bounded, permission-checked). Keyboard first,
 * no animation.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { searchRevenueAction, type SearchHit } from "./search-actions";

export type PaletteDict = {
  open: string;
  placeholder: string;
  nothing: string;
  commands: string;
  results: string;
  shortcut: string;
};

export function RevenueCommandPalette({
  orgId,
  commands,
  dict,
}: {
  orgId: string;
  commands: Array<{ id: string; label: string; href: string }>;
  dict: PaletteDict;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQ("");
        setHits([]);
        setCursor(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) return; // short queries show no hits (see shownHits) without a state write
    const mine = ++seq.current;
    const handle = setTimeout(() => {
      void searchRevenueAction(orgId, needle).then((r) => {
        if (mine === seq.current) setHits(r);
      });
    }, 200);
    return () => clearTimeout(handle);
  }, [q, orgId]);

  const needle = q.trim().toLowerCase();
  const shownHits = needle.length >= 2 ? hits : [];
  const cmds = commands.filter((c) => !needle || c.label.toLowerCase().includes(needle));
  const items = [
    ...shownHits.map((h) => ({
      id: `${h.kind}:${h.id}`,
      label: h.label,
      hint: h.hint,
      href: h.href,
    })),
    ...cmds.map((c) => ({ id: `cmd:${c.id}`, label: c.label, hint: dict.commands, href: c.href })),
  ];
  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line bg-card px-3 text-sm text-ink-secondary hover:bg-sunken"
        aria-haspopup="dialog"
      >
        {dict.open}
        <kbd className="rounded border border-line px-1 text-[10px] text-ink-muted">
          {dict.shortcut}
        </kbd>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={dict.open}
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-lg border border-line bg-card shadow-lg"
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
                if (e.key === "Escape") setOpen(false);
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCursor((c) => Math.min(items.length - 1, c + 1));
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCursor((c) => Math.max(0, c - 1));
                }
                if (e.key === "Enter" && items[cursor]) go(items[cursor].href);
              }}
              placeholder={dict.placeholder}
              className="min-h-12 w-full rounded-t-lg border-b border-line bg-transparent px-4 text-sm text-ink outline-none"
              aria-label={dict.placeholder}
            />
            <ul role="listbox" className="max-h-80 overflow-y-auto p-1">
              {items.length === 0 ? (
                <li className="px-3 py-2 text-sm text-ink-muted">{dict.nothing}</li>
              ) : null}
              {items.map((it, i) => (
                <li
                  key={it.id}
                  role="option"
                  aria-selected={i === cursor}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => go(it.href)}
                  className={`flex cursor-pointer items-center justify-between gap-2 rounded-md px-3 py-2 text-sm ${
                    i === cursor ? "bg-brand-soft text-brand-strong" : "text-ink"
                  }`}
                >
                  <span className="truncate">{it.label}</span>
                  <span className="shrink-0 text-xs text-ink-muted">{it.hint}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
